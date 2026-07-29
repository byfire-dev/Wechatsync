(function() {
  console.log('api ready');

  var BRIDGE_NAMESPACE = 'vibemarket.syncer.bridge';
  var BRIDGE_API_VERSION = '2.0';
  var PUBLICATION_BRIDGE_API_VERSION_V3 = '3.0';
  var PUBLICATION_BRIDGE_REQUEST_ID_MAX_LENGTH_V3 = 128;
  var PUBLICATION_BRIDGE_TIMEOUT_MS_V3 = 15000;
  var BRIDGE_REQUEST_DIRECTION = 'PAGE_TO_EXTENSION';
  var BRIDGE_RESPONSE_DIRECTION = 'EXTENSION_TO_PAGE';

  var poster = {
    versionNumber: 1001,
    dev: location.hostname === 'localhost' || location.hostname === '127.0.0.1',
  };

  var eventCb = {};
  var bridgeEventCb = {};
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

  function normalizePublicationBridgeRequestIdV3(value) {
    if (typeof value !== 'string') return null;
    var normalized = value.trim();
    if (
      normalized.length === 0 ||
      normalized.length > PUBLICATION_BRIDGE_REQUEST_ID_MAX_LENGTH_V3
    ) {
      return null;
    }
    return normalized;
  }

  function callPublicationBridgeV3(method, payload, cb, requestId) {
    var callback = typeof cb === 'function' ? cb : function() {};
    var id = normalizePublicationBridgeRequestIdV3(requestId);
    if (id === null) {
      callback({
        code: 'INVALID_REQUEST_ID',
        message: 'Publication Bridge requestId must be a non-empty string.',
      });
      return;
    }

    var callbackKey = bridgeCallbackKey(
      PUBLICATION_BRIDGE_API_VERSION_V3,
      id
    );
    if (bridgeEventCb[callbackKey]) {
      callback({
        code: 'DUPLICATE_REQUEST_ID',
        message: 'A Publication Bridge request with this requestId is pending.',
      });
      return;
    }

    var normalizedPayload = payload || {};
    if (method === 'inspectPublicationV3') {
      normalizedPayload = {};
      if (payload && typeof payload === 'object') {
        Object.keys(payload).forEach(function(key) {
          normalizedPayload[key] = payload[key];
        });
      }
      normalizedPayload.requestId = id;
    }

    var pending = {
      method: method,
      apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
      callback: callback,
      timeoutId: undefined,
    };
    bridgeEventCb[callbackKey] = pending;
    pending.timeoutId = setTimeout(function() {
      if (bridgeEventCb[callbackKey] !== pending) return;
      delete bridgeEventCb[callbackKey];
      pending.callback({
        code: 'BRIDGE_REQUEST_TIMEOUT',
        message: 'The Publication Bridge request timed out.',
      });
    }, PUBLICATION_BRIDGE_TIMEOUT_MS_V3);

    window.postMessage(
      {
        namespace: BRIDGE_NAMESPACE,
        apiVersion: PUBLICATION_BRIDGE_API_VERSION_V3,
        direction: BRIDGE_REQUEST_DIRECTION,
        requestId: id,
        method: method,
        payload: normalizedPayload,
      },
      location.origin
    );
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

  poster.getPublicationBridgeInfoV3 = function(cb) {
    callPublicationBridgeV3(
      'getPublicationBridgeInfoV3',
      {},
      cb,
      createBridgeRequestId()
    );
  };

  poster.inspectPublicationV3 = function(request, cb) {
    callPublicationBridgeV3(
      'inspectPublicationV3',
      request,
      cb,
      request && request.requestId
    );
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
        evt.data.namespace === BRIDGE_NAMESPACE &&
        (evt.data.apiVersion === BRIDGE_API_VERSION ||
          evt.data.apiVersion === PUBLICATION_BRIDGE_API_VERSION_V3) &&
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

        var isPublicationBridgeV3 =
          evt.data.apiVersion === PUBLICATION_BRIDGE_API_VERSION_V3;
        if (isPublicationBridgeV3) {
          if (bridgeCallback.timeoutId !== undefined) {
            clearTimeout(bridgeCallback.timeoutId);
          }
          delete bridgeEventCb[callbackKey];
        }

        if (evt.data.ok) {
          bridgeCallback.callback(null, evt.data.result);
        } else {
          bridgeCallback.callback(evt.data.error || {
            code: 'UNKNOWN_ERROR',
            message: 'Bridge request failed',
          });
        }
        if (!isPublicationBridgeV3) {
          delete bridgeEventCb[callbackKey];
        }
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
