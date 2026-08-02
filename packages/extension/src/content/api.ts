/**
 * API 兼容层 - 提供 $syncer/$poster API（兼容旧版插件）
 *
 * 旧版 API:
 * - $syncer.getAccounts(cb) - 获取已登录平台
 * - $syncer.addTask(task, statusHandler, cb) - 添加同步任务
 * - $syncer.uploadImage(data, cb) - 上传图片（实际调用 magicCall）
 * - $syncer.magicCall(data, cb) - 魔术调用
 * - $syncer.updateDriver(data, cb) - 更新驱动（敏感API，仅白名单）
 * - $syncer.startInspect(handler, cb) - 开始检查（敏感API，仅白名单）
 *
 * 注入脚本位于 public/inject-api.js（Manifest V3 不支持内联脚本）
 */

import { htmlToMarkdownNative } from '@wechatsync/core'
import type {
  OpenPublicationDraftResult,
  PublicationObservation,
  SyncerAccountV2,
  SyncerAccountsV2Detailed,
} from '@wechatsync/core/publication-inspection'
import { createLogger } from '../lib/logger'
import {
  BRIDGE_API_VERSION,
  BRIDGE_NAMESPACE,
  createBridgeErrorResponse,
  createBridgeSuccessResponse,
  deriveLegacySyncTargets,
  getPublicationBridgeOperationToRunV3,
  isLegacyMutationMethod,
  INVALID_ACCOUNT_BINDINGS,
  LEGACY_API_ORIGIN_NOT_ALLOWED,
  projectBridgeRuntimeError,
  parseLegacyPageActionEvent,
  parseBridgeRequestEvent,
  parsePublicationBridgeRequestEventV3,
  parsePublicationBridgeResponseForRequestV3,
  validateLegacyMutationPageEvent,
  type BridgeErrorResponse,
  type BridgeRequest,
  type BridgeResponse,
  type PublicationBridgeV3Request,
  type PublicationBridgeV3Response,
} from '../bridge'
import { projectLegacyAccounts } from '../bridge/legacy-account'
import { LEGACY_MAGIC_CALL_METHOD_NOT_ALLOWED } from '../bridge/legacy-magic-call'
import {
  getLegacySyncResultRoutingAccountId,
  LEGACY_OUTCOME_UNKNOWN_MESSAGE,
  toLegacyEditResponse,
  toLegacySyncAccountUpdate,
  toLegacyTerminalDetailAccountUpdate,
} from '../bridge/sync-result'

const logger = createLogger('Wechatsync')

const BRIDGE_CAPABILITIES = [
  'account_identity',
  'draft_open',
  'publication_inspect',
  'public_url',
] as const

interface BridgeRuntimeResponse {
  accounts?: SyncerAccountV2[]
  detailedAccounts?: SyncerAccountsV2Detailed
  draftOpenResult?: OpenPublicationDraftResult
  observations?: PublicationObservation[]
  error?: string
}

// 当前同步任务 ID（用于过滤消息）
let currentSyncId: string | null = null;

// 当前同步任务的账户状态（兼容旧版 API）
interface AccountStatus {
  type: string;
  title: string;
  displayName?: string;
  icon?: string;
  avatar?: string;
  uid?: string;
  externalAccountId?: string;
  requestedExternalAccountId?: string;
  observedExternalAccountId?: string;
  home?: string;
  supportTypes?: string[];
  status: 'pending' | 'uploading' | 'done' | 'failed';
  outcome?: 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN';
  retryable?: boolean;
  msg?: string;
  error?: string;
  editResp?: { draftLink?: string; postId?: string } | null;
}
let currentAccounts: AccountStatus[] = [];

function failCurrentAccounts(error: string) {
  currentAccounts = currentAccounts.map((account) => ({
    ...account,
    status: 'failed',
    msg: undefined,
    error,
  }))
  sendTaskUpdate({ accounts: currentAccounts })
}

/**
 * 发送消息到页面
 */
function sendToWindow(
  msg: Record<string, unknown>,
  targetOrigin = window.location.origin
) {
  msg.callReturn = true;
  window.postMessage(JSON.stringify(msg), targetOrigin);
}

/**
 * 发送进度更新到页面
 */
function sendTaskUpdate(task: Record<string, unknown>) {
  window.postMessage(JSON.stringify({
    method: 'taskUpdate',
    task,
  }), window.location.origin);
}

/**
 * 发送控制台日志到页面
 */
function sendConsoleLog(args: unknown) {
  window.postMessage(JSON.stringify({
    method: 'consoleLog',
    args,
  }), window.location.origin);
}

function postBridgeResponse(
  response: BridgeResponse | PublicationBridgeV3Response,
  targetOrigin: string,
) {
  window.postMessage(response, targetOrigin)
}

function createBridgeFailure(
  request: BridgeRequest,
  code: string,
  message: string
): BridgeErrorResponse {
  switch (request.method) {
    case 'getBridgeInfo':
      return createBridgeErrorResponse(request, { code, message })
    case 'getAccountsV2':
    case 'getAccountsV2Detailed':
      return createBridgeErrorResponse(request, { code, message })
    case 'inspectPublication':
      return createBridgeErrorResponse(request, { code, message })
    case 'openPublicationDraft':
      return createBridgeErrorResponse(request, { code, message })
  }
}

function sendBridgeRuntimeMessage(
  message: Record<string, unknown>
): Promise<BridgeRuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: BridgeRuntimeResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }

      if (response?.error) {
        reject(new Error(response.error))
        return
      }

      resolve(response || {})
    })
  })
}

function sendPublicationBridgeRuntimeMessageV3(
  request: PublicationBridgeV3Request,
): Promise<PublicationBridgeV3Response> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'BRIDGE_CALL_V3', request },
      (response: unknown) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        const parsed = parsePublicationBridgeResponseForRequestV3(
          request,
          response,
        )
        if (!parsed.success) {
          reject(new Error('Publication Bridge returned an invalid response'))
          return
        }

        resolve(parsed.data)
      },
    )
  })
}

function keepPublicationBridgeOperationAliveV3(operationId: string): void {
  chrome.runtime.sendMessage(
    { type: 'BRIDGE_RUN_PUBLICATION_OPERATION_V3', operationId },
    () => {
      if (chrome.runtime.lastError) {
        logger.error(
          'Publication Bridge operation runner disconnected:',
          chrome.runtime.lastError,
        )
      }
    },
  )
}

async function handleBridgeRequest(evt: MessageEvent): Promise<void> {
  if (window.top !== window) return

  const data = evt.data
  if (
    typeof data !== 'object' ||
    data === null ||
    data.namespace !== BRIDGE_NAMESPACE
  ) {
    return
  }

  const parsed = parseBridgeRequestEvent(evt, window)
  if (!parsed.success) return

  const request = parsed.data

  try {
    switch (request.method) {
      case 'getBridgeInfo': {
        postBridgeResponse(
          createBridgeSuccessResponse(request, {
            apiVersion: BRIDGE_API_VERSION,
            extensionVersion: chrome.runtime.getManifest().version,
            capabilities: [...BRIDGE_CAPABILITIES],
          }),
          evt.origin
        )
        return
      }

      case 'getAccountsV2': {
        const response = await sendBridgeRuntimeMessage({
          type: 'BRIDGE_GET_ACCOUNTS_V2',
          requestId: request.requestId,
          payload: request.payload,
        })
        if (!response.accounts) {
          throw new Error('Bridge account response is missing')
        }
        postBridgeResponse(
          createBridgeSuccessResponse(request, response.accounts),
          evt.origin
        )
        return
      }

      case 'getAccountsV2Detailed': {
        const response = await sendBridgeRuntimeMessage({
          type: 'BRIDGE_GET_ACCOUNTS_V2_DETAILED',
          requestId: request.requestId,
          payload: request.payload,
        })
        if (!response.detailedAccounts) {
          throw new Error('Detailed Bridge account response is missing')
        }
        postBridgeResponse(
          createBridgeSuccessResponse(request, response.detailedAccounts),
          evt.origin
        )
        return
      }

      case 'inspectPublication': {
        const response = await sendBridgeRuntimeMessage({
          type: 'BRIDGE_INSPECT_PUBLICATION',
          requestId: request.requestId,
          payload: request.payload,
        })
        if (!response.observations) {
          throw new Error('Bridge inspection response is missing')
        }
        postBridgeResponse(
          createBridgeSuccessResponse(request, response.observations),
          evt.origin
        )
        return
      }

      case 'openPublicationDraft': {
        const response = await sendBridgeRuntimeMessage({
          type: 'BRIDGE_OPEN_PUBLICATION_DRAFT',
          requestId: request.requestId,
          payload: request.payload,
        })
        if (!response.draftOpenResult) {
          throw new Error('Bridge draft-open response is missing')
        }
        postBridgeResponse(
          createBridgeSuccessResponse(request, response.draftOpenResult),
          evt.origin
        )
        return
      }
    }
  } catch (error) {
    const failure = projectBridgeRuntimeError(error)
    postBridgeResponse(
      createBridgeFailure(
        request,
        failure.code,
        failure.message
      ),
      evt.origin
    )
  }
}

export async function handlePublicationBridgeRequestV3(
  evt: MessageEvent,
): Promise<void> {
  if (window.top !== window) return
  if (evt.source !== window || evt.origin !== window.location.origin) return

  const parsed = parsePublicationBridgeRequestEventV3(evt, window)
  if (!parsed.success) return
  const request = parsed.data

  try {
    const response = await sendPublicationBridgeRuntimeMessageV3(request)

    // Return the accepted/replayed envelope before opening the long-lived
    // operation runner, so page latency never includes the platform write.
    postBridgeResponse(response, evt.origin)

    const operationId = getPublicationBridgeOperationToRunV3(request, response)
    if (operationId) {
      keepPublicationBridgeOperationAliveV3(operationId)
    }
  } catch (error) {
    logger.error('Publication Bridge request failed:', error)
  }
}

window.addEventListener('message', (evt) => {
  void handleBridgeRequest(evt)
  void handlePublicationBridgeRequestV3(evt)
})

/**
 * 监听来自 background 的消息
 */
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  try {
    // 过滤不相关的 syncId
    if (message.syncId && currentSyncId && message.syncId !== currentSyncId) {
      return;
    }

    // 旧版 taskUpdate 消息格式
    if (message.method === 'taskUpdate') {
      sendToWindow({
        task: message.task,
        method: 'taskUpdate',
      });
      return;
    }

    // 旧版 consoleLog 消息格式
    if (message.method === 'consoleLog') {
      sendToWindow({
        args: message.args,
        method: 'consoleLog',
      });
      return;
    }

    // 新版同步进度更新 -> 转换为旧版格式（更新对应账户状态）
    if (message.type === 'SYNC_PROGRESS') {
      const result = message.result || message.payload?.result;
      if (result) {
        const routingExternalAccountId =
          getLegacySyncResultRoutingAccountId(result);
        // 更新对应账户的状态
        const account = currentAccounts.find(
          (candidate) =>
            candidate.type === result.platform &&
            (routingExternalAccountId === undefined ||
              candidate.externalAccountId === routingExternalAccountId),
        );
        if (account) {
          Object.assign(account, toLegacySyncAccountUpdate(result));
        }
        // 发送完整的账户状态列表
        sendTaskUpdate({ accounts: currentAccounts });
      }
    }

    // 新版详细进度更新 -> 转换为旧版格式（更新对应账户状态）
    if (message.type === 'SYNC_DETAIL_PROGRESS') {
      const progress = message.payload || message;
      // 更新对应账户的状态
      const account = currentAccounts.find(
        (candidate) =>
          candidate.type === progress.platform &&
          (typeof progress.externalAccountId !== 'string' ||
            candidate.externalAccountId === progress.externalAccountId),
      );
      if (account) {
        const terminalUpdate = toLegacyTerminalDetailAccountUpdate(progress)
        if (terminalUpdate) {
          Object.assign(account, terminalUpdate)
        } else if (progress.stage === 'review_required') {
          account.status = 'done';
          account.outcome = 'OUTCOME_UNKNOWN';
          account.retryable = false;
          account.msg = LEGACY_OUTCOME_UNKNOWN_MESSAGE;
          account.error = progress.error;
          account.editResp = toLegacyEditResponse(progress.result);
        } else if (progress.stage === 'completed') {
          account.status = 'done';
          account.msg = undefined;
          account.error = progress.error;
          account.editResp = toLegacyEditResponse(progress.result);
        } else if (progress.stage === 'failed') {
          account.status = 'failed';
          account.msg = undefined;
          account.error = progress.error;
          account.editResp = null;
        } else {
          account.status = 'uploading';
          account.msg = progress.stage === 'uploading_images'
            ? `上传图片 ${progress.imageProgress?.current}/${progress.imageProgress?.total}`
            : progress.stage === 'saving' ? '保存中...' : progress.stage;
        }
      }
      // 发送完整的账户状态列表
      sendTaskUpdate({ accounts: currentAccounts });
    }

    // 同步完成
    if (message.type === 'SYNC_COMPLETE') {
      currentSyncId = null;
      currentAccounts = [];
    }
  } catch (e) {
    logger.error('Error handling message:', e);
  }
});

/**
 * 监听来自页面的消息
 */
window.addEventListener('message', async (evt) => {
  const action = parseLegacyPageActionEvent(evt, window)
  if (!action) return

  if (isLegacyMutationMethod(action.method)) {
    const validation = validateLegacyMutationPageEvent(
      evt,
      window,
      window.top === window
    )
    if (!validation.success) {
      sendToWindow(
        {
          eventID: action.eventID,
          result: { error: LEGACY_API_ORIGIN_NOT_ALLOWED },
        },
        window.location.origin
      )
      return
    }
  }

  try {
    // getAccounts - 获取已登录平台（任何页面可调用）
    if (action.method === 'getAccounts') {
      chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH' }, (resp) => {
        if (chrome.runtime.lastError) {
          logger.error('getAccounts error:', chrome.runtime.lastError);
          sendToWindow({ eventID: action.eventID, result: [] });
          return;
        }

        // 只返回已登录的平台（与旧版保持一致）
        const accounts = projectLegacyAccounts(resp?.platforms || []);

        sendToWindow({ eventID: action.eventID, result: accounts });
      });
    }

    // addTask - 添加同步任务（仅允许构建时配置的 VibeMarket origin）
    if (action.method === 'addTask') {
      const { task } = action;
      const { post, accounts } = task;
      const targets = deriveLegacySyncTargets(accounts);
      if (!targets.success) {
        currentAccounts = Array.isArray(accounts)
          ? accounts.flatMap((account: unknown) => {
              if (
                typeof account !== 'object' ||
                account === null ||
                Array.isArray(account) ||
                typeof (account as Record<string, unknown>).type !== 'string'
              ) {
                return []
              }
              const candidate = account as Record<string, unknown>
              return [{
                type: candidate.type as string,
                title:
                  typeof candidate.title === 'string'
                    ? candidate.title
                    : candidate.type as string,
                status: 'failed' as const,
                error: INVALID_ACCOUNT_BINDINGS,
                editResp: null,
              }]
            })
          : []
        sendTaskUpdate({ accounts: currentAccounts })
        return
      }
      const { platforms, accountBindings } = targets;
      const bindingsByPlatform = new Map(
        accountBindings.map((binding) => [binding.platform, binding]),
      )

      // 生成 syncId 用于追踪进度
      currentSyncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // 初始化账户状态（保留原始账户信息：icon、title 等）
      currentAccounts = accounts.map((a: any) => ({
        type: a.type,
        title: a.title,
        displayName: a.displayName,
        icon: a.icon,
        avatar: a.avatar,
        uid: a.uid,
        ...(bindingsByPlatform.has(a.type)
          ? {
              externalAccountId:
                bindingsByPlatform.get(a.type)!.externalAccountId,
            }
          : {}),
        home: a.home,
        supportTypes: a.supportTypes,
        status: 'uploading' as const,
        msg: '准备同步...',
        error: undefined,
        editResp: null,
      }));

      // 立即发送初始状态
      sendTaskUpdate({ accounts: currentAccounts });

      // 如果没有 markdown 但有 content，自动转换
      const htmlContent = post.content || '';
      const markdown = post.markdown || (htmlContent ? htmlToMarkdownNative(htmlContent) : '');

      chrome.runtime.sendMessage({
        type: 'SYNC_ARTICLE',
        payload: {
          article: {
            title: post.title,
            content: htmlContent,
            html: htmlContent,
            markdown,
            cover: post.thumb,
          },
          platforms,
          ...(accountBindings.length > 0 ? { accountBindings } : {}),
          source: 'legacy-api',
          syncId: currentSyncId,
        },
      }, (resp) => {
        if (chrome.runtime.lastError) {
          logger.error('addTask error:', chrome.runtime.lastError);
          failCurrentAccounts('SYNC_RUNTIME_ERROR')
          currentSyncId = null
          return
        }
        if (resp?.error) {
          logger.error('addTask rejected:', resp.error)
          failCurrentAccounts(
            typeof resp.error === 'string'
              ? resp.error
              : INVALID_ACCOUNT_BINDINGS,
          )
          currentSyncId = null
        }
      });
    }

    // magicCall - 魔术调用（仅允许构建时配置的 VibeMarket origin）
    if (action.method === 'magicCall') {
      const { methodName, data } = action;

      // uploadImage 特殊处理
      if (methodName === 'uploadImage') {
        chrome.runtime.sendMessage({
          type: 'UPLOAD_IMAGE',
          payload: {
            src: data.src,
            platform: data.account?.type || 'weibo',
          },
        }, (resp) => {
          if (chrome.runtime.lastError) {
            sendToWindow({ eventID: action.eventID, result: { error: chrome.runtime.lastError.message } });
            return;
          }
          sendToWindow({ eventID: action.eventID, result: resp });
        });
      } else {
        sendToWindow({
          eventID: action.eventID,
          result: { error: LEGACY_MAGIC_CALL_METHOD_NOT_ALLOWED },
        });
      }
    }

    // updateDriver - 更新驱动
    if (action.method === 'updateDriver') {
      // v2 版本不再支持动态更新驱动，返回成功但不做任何事
      logger.warn('updateDriver is deprecated in v2');
      sendToWindow({ eventID: action.eventID, result: { success: true, deprecated: true } });
    }

    // startInspect - 开始检查
    if (action.method === 'startInspect') {
      // v2 版本不再支持 inspect 模式，返回成功但不做任何事
      logger.warn('startInspect is deprecated in v2');
      sendToWindow({ eventID: action.eventID, result: { success: true, deprecated: true } });
    }

  } catch (e) {
    logger.error('Error handling legacy page action:', e)
  }
});

/**
 * 注入 API 到页面（使用外部脚本文件，Manifest V3 兼容）
 */
function injectAPI() {
  setTimeout(function() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject-api.js');
    script.onload = function() {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }, 50);
}

// 页面加载后注入
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectAPI);
} else {
  injectAPI();
}
