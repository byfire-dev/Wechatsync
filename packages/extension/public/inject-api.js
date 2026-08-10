(function() {
  console.log('api ready');

  var BRIDGE_NAMESPACE = 'vibemarket.syncer.bridge';
  var BRIDGE_API_VERSION = '2.0';
  var PUBLICATION_BRIDGE_NAMESPACE_V3 = 'byfire.publication-bridge';
  var PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3 = 3;
  var PUBLICATION_BRIDGE_REQUEST_ID_MAX_LENGTH_V3 = 128;
  // Pre-3.2 calls retain their fixed transport fallbacks. Wire 3.2 inspection
  // instead shares the caller's absolute deadline across every hop.
  var PUBLICATION_BRIDGE_TIMEOUT_MS_V3 = 30000;
  var PUBLICATION_INSPECT_TIMEOUT_MS_V3 = 40000;
  var BRIDGE_REQUEST_DIRECTION = 'PAGE_TO_EXTENSION';
  var BRIDGE_RESPONSE_DIRECTION = 'EXTENSION_TO_PAGE';
  var PUBLICATION_BRIDGE_REQUEST_DIRECTION_V3 = 'REQUEST';
  var PUBLICATION_BRIDGE_RESPONSE_DIRECTION_V3 = 'RESPONSE';
  var PUBLICATION_BRIDGE_TRANSPORT_ERROR_DIRECTION_V3 = 'TRANSPORT_ERROR';

  var poster = {
    versionNumber: 1001,
    dev: location.hostname === 'localhost' || location.hostname === '127.0.0.1',
  };

  var eventCb = {};
  var bridgeEventCb = {};
  var publicationBridgeEventCbV3 = Object.create(null);
  var publicationBridgeCancelSequenceV3 = 0;
  var _statueandler = null;
  var _consolehandler = null;

  function callFunc(msg, cb) {
    msg.eventID = Math.floor(Date.now() + Math.random() * 100);
    eventCb[msg.eventID] = function(err, res) {
      cb(err, res);
    };
    window.postMessage(JSON.stringify(msg), location.origin);
  }

  function createBridgeRequestId() {
    return 'bridge_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  function bridgeCallbackKey(apiVersion, requestId) {
    return apiVersion + ':' + requestId;
  }

  function callBridge(method, payload, cb, requestId, apiVersion) {
    var id = requestId || createBridgeRequestId();
    var requestedApiVersion = apiVersion || BRIDGE_API_VERSION;
    bridgeEventCb[bridgeCallbackKey(requestedApiVersion, id)] = {
      method: method,
      apiVersion: requestedApiVersion,
      callback: typeof cb === 'function' ? cb : function() {},
    };

    window.postMessage(
      {
        namespace: BRIDGE_NAMESPACE,
        apiVersion: requestedApiVersion,
        direction: BRIDGE_REQUEST_DIRECTION,
        requestId: id,
        method: method,
        payload: payload || {},
      },
      location.origin
    );
  }

  function isPublicationBridgeRequestV3(request) {
    return (
      request &&
      typeof request === 'object' &&
      !Array.isArray(request) &&
      request.namespace === PUBLICATION_BRIDGE_NAMESPACE_V3 &&
      request.direction === PUBLICATION_BRIDGE_REQUEST_DIRECTION_V3 &&
      request.protocolMajor === PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3 &&
      typeof request.requestId === 'string' &&
      request.requestId.length > 0 &&
      request.requestId.length <= PUBLICATION_BRIDGE_REQUEST_ID_MAX_LENGTH_V3 &&
      request.requestId === request.requestId.trim() &&
      typeof request.command === 'string' &&
      request.command.length > 0
    );
  }

  function publicationBridgeTimeoutMsV3(command) {
    return command === 'publication.inspect'
      ? PUBLICATION_INSPECT_TIMEOUT_MS_V3
      : PUBLICATION_BRIDGE_TIMEOUT_MS_V3;
  }

  function noopPublicationBridgeCancelHandle() {
    return {
      cancel: function() {
        return false;
      },
    };
  }

  function isPublicationInspectRequestV32(request) {
    return (
      request.command === 'publication.inspect' &&
      request.contractVersion === '3.2' &&
      typeof request.sessionId === 'string' &&
      typeof request.operationId === 'string' &&
      typeof request.deadlineAt === 'string' &&
      Number.isFinite(Date.parse(request.deadlineAt))
    );
  }

  function postPublicationBridgeCancelV3(request, reason) {
    var cancelRequestId;
    do {
      publicationBridgeCancelSequenceV3 += 1;
      cancelRequestId =
        'bridge_cancel_' + Date.now() + '_' + publicationBridgeCancelSequenceV3;
    } while (cancelRequestId === request.requestId);
    window.postMessage(
      {
        namespace: PUBLICATION_BRIDGE_NAMESPACE_V3,
        direction: PUBLICATION_BRIDGE_REQUEST_DIRECTION_V3,
        protocolMajor: PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3,
        contractVersion: '3.2',
        sessionId: request.sessionId,
        requestId: cancelRequestId,
        operationId: request.operationId,
        command: 'bridge.cancel',
        payload: {
          targetRequestId: request.requestId,
          targetCommand: 'publication.inspect',
          reason: reason,
        },
      },
      location.origin
    );
  }

  function settlePublicationBridgeV3(
    id,
    pending,
    error,
    response,
    cancellationReason
  ) {
    if (publicationBridgeEventCbV3[id] !== pending) return false;
    delete publicationBridgeEventCbV3[id];
    if (pending.timeoutId !== undefined) clearTimeout(pending.timeoutId);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    if (cancellationReason && pending.cancellable) {
      postPublicationBridgeCancelV3(pending.request, cancellationReason);
    }
    if (response === undefined) {
      pending.callback(error);
    } else {
      pending.callback(error, response);
    }
    return true;
  }

  function callPublicationBridgeV3(request, cb, options) {
    var callback = typeof cb === 'function' ? cb : function() {};
    var cancellable = isPublicationInspectRequestV32(request || {});
    if (
      !isPublicationBridgeRequestV3(request) ||
      (request &&
        request.command === 'publication.inspect' &&
        request.contractVersion === '3.2' &&
        !cancellable)
    ) {
      callback({
        code: 'INVALID_BRIDGE_REQUEST',
        message: 'Publication Bridge request is invalid.',
      });
      return noopPublicationBridgeCancelHandle();
    }

    var id = request.requestId;
    if (publicationBridgeEventCbV3[id]) {
      callback({
        code: 'DUPLICATE_REQUEST_ID',
        message: 'A Publication Bridge request with this requestId is pending.',
      });
      return noopPublicationBridgeCancelHandle();
    }

    var pending = {
      command: request.command,
      callback: callback,
      request: request,
      cancellable: cancellable,
      signal: undefined,
      abortListener: undefined,
      timeoutId: undefined,
    };
    publicationBridgeEventCbV3[id] = pending;
    var cancelHandle = {
      cancel: function(reason) {
        if (!pending.cancellable) return false;
        var cancellationReason =
          reason === 'DEADLINE_EXCEEDED'
            ? 'DEADLINE_EXCEEDED'
            : 'CALLER_ABORTED';
        return settlePublicationBridgeV3(
          id,
          pending,
          cancellationReason === 'DEADLINE_EXCEEDED'
            ? {
                code: 'BRIDGE_REQUEST_TIMEOUT',
                message: 'The Publication Bridge request timed out.',
              }
            : {
                code: 'BRIDGE_REQUEST_ABORTED',
                message: 'The Publication Bridge request was cancelled.',
              },
          undefined,
          cancellationReason
        );
      },
    };

    if (
      cancellable &&
      options &&
      options.signal &&
      typeof options.signal.addEventListener === 'function'
    ) {
      pending.signal = options.signal;
      pending.abortListener = function() {
        cancelHandle.cancel('CALLER_ABORTED');
      };
      if (pending.signal.aborted) {
        settlePublicationBridgeV3(
          id,
          pending,
          {
            code: 'BRIDGE_REQUEST_ABORTED',
            message: 'The Publication Bridge request was cancelled.',
          }
        );
        return cancelHandle;
      }
      pending.signal.addEventListener('abort', pending.abortListener, {
        once: true,
      });
    }

    var timeoutMs = cancellable
      ? Math.max(0, Date.parse(request.deadlineAt) - Date.now())
      : publicationBridgeTimeoutMsV3(request.command);
    pending.timeoutId = setTimeout(function() {
      settlePublicationBridgeV3(
        id,
        pending,
        {
          code: 'BRIDGE_REQUEST_TIMEOUT',
          message: 'The Publication Bridge request timed out.',
        },
        undefined,
        cancellable ? 'DEADLINE_EXCEEDED' : undefined
      );
    }, timeoutMs);

    window.postMessage(request, location.origin);
    return cancelHandle;
  }

  poster.getAccounts = function(cb) {
    callFunc(
      {
        method: 'getAccounts',
      },
      cb
    );
  };

  poster.getBridgeInfo = function(cb) {
    callBridge('getBridgeInfo', {}, cb);
  };

  poster.getAccountsV2 = function(options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    callBridge('getAccountsV2', options || {}, cb);
  };

  poster.getAccountsV2Detailed = function(options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    callBridge('getAccountsV2Detailed', options || {}, cb);
  };

  poster.inspectPublication = function(request, cb) {
    callBridge(
      'inspectPublication',
      request,
      cb,
      request && request.requestId
    );
  };

  poster.callPublicationBridgeV3 = function(request, cb, options) {
    return callPublicationBridgeV3(request, cb, options);
  };

  poster.openPublicationDraft = function(request, cb) {
    callBridge(
      'openPublicationDraft',
      request,
      cb,
      request && request.requestId
    );
  };

  poster.addTask = function(task, statueandler, cb) {
    _statueandler = statueandler;
    callFunc(
      {
        method: 'addTask',
        task: task,
      },
      cb
    );
  };

  poster.magicCall = function(data, cb) {
    callFunc(
      {
        method: 'magicCall',
        methodName: data.methodName,
        data: data,
      },
      cb
    );
  };

  poster.updateDriver = function(data, cb) {
    callFunc(
      {
        method: 'updateDriver',
        data: data,
      },
      cb
    );
  };

  poster.startInspect = function(handler, cb) {
    _consolehandler = handler;
    callFunc(
      {
        method: 'startInspect',
      },
      cb
    );
  };

  poster.uploadImage = function(data, cb) {
    callFunc(
      {
        method: 'magicCall',
        methodName: 'uploadImage',
        data: data,
      },
      cb
    );
  };

  window.addEventListener('message', function(evt) {
    try {
      if (
        evt.source === window &&
        evt.origin === location.origin &&
        evt.data &&
        typeof evt.data === 'object' &&
        evt.data.namespace === PUBLICATION_BRIDGE_NAMESPACE_V3 &&
        evt.data.direction === PUBLICATION_BRIDGE_TRANSPORT_ERROR_DIRECTION_V3 &&
        evt.data.protocolMajor === PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3
      ) {
        var publicationBridgeTransportCallback =
          publicationBridgeEventCbV3[evt.data.requestId];
        if (
          !publicationBridgeTransportCallback ||
          publicationBridgeTransportCallback.command !== evt.data.command ||
          !evt.data.error ||
          typeof evt.data.error !== 'object' ||
          typeof evt.data.error.code !== 'string' ||
          typeof evt.data.error.message !== 'string'
        ) return;

        settlePublicationBridgeV3(
          evt.data.requestId,
          publicationBridgeTransportCallback,
          evt.data.error
        );
        return;
      }

      if (
        evt.source === window &&
        evt.origin === location.origin &&
        evt.data &&
        typeof evt.data === 'object' &&
        evt.data.namespace === PUBLICATION_BRIDGE_NAMESPACE_V3 &&
        evt.data.direction === PUBLICATION_BRIDGE_RESPONSE_DIRECTION_V3 &&
        evt.data.protocolMajor === PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3
      ) {
        var publicationBridgeCallback =
          publicationBridgeEventCbV3[evt.data.requestId];
        if (
          !publicationBridgeCallback ||
          publicationBridgeCallback.command !== evt.data.command ||
          typeof evt.data.ok !== 'boolean'
        ) return;

        // Contract-level ok:false is still a successful transport exchange.
        settlePublicationBridgeV3(
          evt.data.requestId,
          publicationBridgeCallback,
          null,
          evt.data
        );
        return;
      }

      if (
        evt.source === window &&
        evt.origin === location.origin &&
        evt.data &&
        typeof evt.data === 'object' &&
        evt.data.namespace === BRIDGE_NAMESPACE &&
        evt.data.apiVersion === BRIDGE_API_VERSION &&
        evt.data.direction === BRIDGE_RESPONSE_DIRECTION
      ) {
        var callbackKey = bridgeCallbackKey(
          evt.data.apiVersion,
          evt.data.requestId
        );
        var bridgeCallback = bridgeEventCb[callbackKey];
        if (
          !bridgeCallback ||
          bridgeCallback.method !== evt.data.method ||
          bridgeCallback.apiVersion !== evt.data.apiVersion
        ) return;

        if (evt.data.ok) {
          bridgeCallback.callback(null, evt.data.result);
        } else {
          bridgeCallback.callback(evt.data.error || {
            code: 'UNKNOWN_ERROR',
            message: 'Bridge request failed',
          });
        }
        delete bridgeEventCb[callbackKey];
        return;
      }

      if (
        evt.source !== window ||
        evt.origin !== location.origin ||
        typeof evt.data !== 'string'
      ) {
        return;
      }

      var action = JSON.parse(evt.data);
      if (action.method && action.method === 'taskUpdate') {
        if (_statueandler != null) _statueandler(action.task);
        return;
      }

      if (action.method && action.method === 'consoleLog') {
        if (_consolehandler != null) _consolehandler(action.args);
        return;
      }
      if (!action.callReturn) return;
      if (action.eventID && eventCb[action.eventID]) {
        eventCb[action.eventID](action.result);
        delete eventCb[action.eventID];
      }
    } catch (e) {}
  });

  window.$poster = poster;
  window.$syncer = poster;
})();
