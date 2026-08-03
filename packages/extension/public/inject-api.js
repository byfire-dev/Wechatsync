(function() {
  console.log('api ready');

  var BRIDGE_NAMESPACE = 'vibemarket.syncer.bridge';
  var BRIDGE_API_VERSION = '2.0';
  var PUBLICATION_BRIDGE_NAMESPACE_V3 = 'byfire.publication-bridge';
  var PUBLICATION_BRIDGE_PROTOCOL_MAJOR_V3 = 3;
  var PUBLICATION_BRIDGE_REQUEST_ID_MAX_LENGTH_V3 = 128;
  // Account resolution and inspection can each consume a bounded 12 seconds.
  // Keep the page transport deadline above the longest sequential read path.
  var PUBLICATION_BRIDGE_TIMEOUT_MS_V3 = 30000;
  var BRIDGE_REQUEST_DIRECTION = 'PAGE_TO_EXTENSION';
  var BRIDGE_RESPONSE_DIRECTION = 'EXTENSION_TO_PAGE';
  var PUBLICATION_BRIDGE_REQUEST_DIRECTION_V3 = 'REQUEST';
  var PUBLICATION_BRIDGE_RESPONSE_DIRECTION_V3 = 'RESPONSE';

  var poster = {
    versionNumber: 1001,
    dev: location.hostname === 'localhost' || location.hostname === '127.0.0.1',
  };

  var eventCb = {};
  var bridgeEventCb = {};
  var publicationBridgeEventCbV3 = Object.create(null);
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

  function callPublicationBridgeV3(request, cb) {
    var callback = typeof cb === 'function' ? cb : function() {};
    if (!isPublicationBridgeRequestV3(request)) {
      callback({
        code: 'INVALID_BRIDGE_REQUEST',
        message: 'Publication Bridge request is invalid.',
      });
      return;
    }

    var id = request.requestId;
    if (publicationBridgeEventCbV3[id]) {
      callback({
        code: 'DUPLICATE_REQUEST_ID',
        message: 'A Publication Bridge request with this requestId is pending.',
      });
      return;
    }

    var pending = {
      command: request.command,
      callback: callback,
      timeoutId: undefined,
    };
    publicationBridgeEventCbV3[id] = pending;
    pending.timeoutId = setTimeout(function() {
      if (publicationBridgeEventCbV3[id] !== pending) return;
      delete publicationBridgeEventCbV3[id];
      pending.callback({
        code: 'BRIDGE_REQUEST_TIMEOUT',
        message: 'The Publication Bridge request timed out.',
      });
    }, PUBLICATION_BRIDGE_TIMEOUT_MS_V3);

    window.postMessage(request, location.origin);
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

  poster.callPublicationBridgeV3 = function(request, cb) {
    callPublicationBridgeV3(request, cb);
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

        if (publicationBridgeCallback.timeoutId !== undefined) {
          clearTimeout(publicationBridgeCallback.timeoutId);
        }
        delete publicationBridgeEventCbV3[evt.data.requestId];

        // Contract-level ok:false is still a successful transport exchange.
        publicationBridgeCallback.callback(null, evt.data);
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
