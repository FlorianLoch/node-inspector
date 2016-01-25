// This function will be injected into the target process.
module.exports = function injection(require, debug, options) {
  var stackTraceLimit = options.stackTraceLimit;
  var CallFrame = debug.CallFrame;

  var STATE = {
    javaScriptBreakpoints: {}
  };

  var breakpointIdToDebuggerBreakpointIds = new Map();

  debug.registerAgentCommand('Debugger.evaluateOnCallFrame',
    ['callFrameId', 'expression', 'objectGroup',
        'includeCommandLineAPI', 'returnByValue', 'generatePreview'],
    function(args, response, InjectedScript) {
      var execState = this.exec_state_;
      var maximumLimit = execState.frameCount();
      args.unshift(debug.wrapCallFrames(execState, maximumLimit, 3), false);

      response.body = InjectedScript.evaluateOnCallFrame.apply(InjectedScript, args);
    });

  debug.registerAgentCommand('Debugger.getFunctionDetails',
    ['functionId'],
    function(args, response, InjectedScript) {
      var details = InjectedScript.getFunctionDetails.apply(InjectedScript, args);
      response.body = { details: details };
    });

  debug.registerAgentCommand('Debugger.setVariableValue',
    ['callFrameId', 'functionObjectId', 'scopeNumber', 'variableName', 'newValue'],
    function(args, response, InjectedScript) {
      var execState = this.exec_state_;
      var maximumLimit = execState.frameCount();
      args.unshift(debug.wrapCallFrames(execState, maximumLimit, 3));
      args[5] = JSON.stringify(args[5]);

      var error = InjectedScript.setVariableValue.apply(InjectedScript, args);
      if (error) {
        response.body = {
          error: {
            message: error
          }
        };
      }
    });

  debug.registerAgentCommand('Debugger.setBreakpointByUrl',
    ['url', 'urlRegex', 'lineNumber', 'columnNumber', 'condition'],
    function _setBreakpointByUrl(args, response, InjectedScript, DebuggerScript) {
      var url = args[0] || args[1];
      if (!url) {
        response.failure(new Error('Either url or urlRegex must be specified.'));
        return;
      }

      var lineNumber = args[2];
      var columnNumber = args[3] || 0;
      if (columnNumber < 0) {
        response.failure(new Error('Incorrect column number.'));
        return;
      }

      var condition = args[4] || '';
      var isRegex = Boolean(args[1]);

      if (!isRegex) url = debug.convert.inspectorUrlToV8Name(url);

      var breakpointId = (isRegex ? '/' + url + '/' : url) + ':' + lineNumber + ':' + columnNumber;
      var breakpointsCookie = STATE.javaScriptBreakpoints;
      if (breakpointsCookie[breakpointId]) {
        response.failure(new Error('Breakpoint at specified location already exists.'));
        return;
      }

      breakpointsCookie[breakpointId] = {
        url: url,
        lineNumber: lineNumber,
        columnNumber: columnNumber,
        condition: condition,
        isRegex: isRegex
      };

      var debuggerBreakpointIds = new Set();
      breakpointIdToDebuggerBreakpointIds.set(breakpointId, debuggerBreakpointIds);

      var locations = debug.scripts().filter(script => {
        var lineOffset = script.line_offset;
        var lineEnd = script.line_ends.length + lineOffset;
        return matches(script.name, url, isRegex)
          && lineOffset <= lineNumber
          && lineEnd >= lineNumber;
      }).map(script => {
        var info = {
          sourceID: script.id,
          lineNumber: lineNumber,
          columnNumber: columnNumber,
          interstatementLocation: false,
          condition: condition
        };

        var debuggerBreakpointId = DebuggerScript.setBreakpoint(this.exec_state_, info);
        if (debuggerBreakpointId == null) return;

        debuggerBreakpointIds.add(debuggerBreakpointId);

        return {
          scriptId: "" + script.id,
          lineNumber: info.lineNumber,
          columnNumber: info.columnNumber
        };
      });

      response.body = {
        breakpointId: breakpointId,
        locations: locations
      };
    });

  debug.registerAgentCommand('Debugger.removeBreakpoint',
    ['breakpointId'],
    function _removeBreakpoint(args, response, InjectedScript, DebuggerScript) {
      var breakpointId = args[0];
      var breakpointsCookie = STATE.javaScriptBreakpoints;
      delete breakpointsCookie[breakpointId];

      var debuggerBreakpointIds = breakpointIdToDebuggerBreakpointIds.get(breakpointId);
      if (!debuggerBreakpointIds) return;

      debuggerBreakpointIds.forEach(debuggerBreakpointId => {
        DebuggerScript.removeBreakpoint(this.exec_state_, {
          breakpointId: debuggerBreakpointId
        });
      });

      breakpointIdToDebuggerBreakpointIds.delete(breakpointId);
    });

  debug.registerAgentCommand('Debugger.pause', _pause);
  debug.registerAgentCommand('Debugger.resume', _continue);
  debug.registerAgentCommand('Debugger.stepOver', _stepOver);
  debug.registerAgentCommand('Debugger.stepInto', _stepInto);
  debug.registerAgentCommand('Debugger.stepOut', _stepOut);
  debug.registerAgentCommand('Debugger.restartFrame', ['callFrameId'], _restartFrame);
  debug.registerAgentCommand('Debugger.setBreakpointsActive', ['active'], _setBreakpointsActive);
  debug.registerAgentCommand('Debugger.getBacktrace', _getBacktrace);


  function _getBacktrace(args, response, InjectedScript) {
    if (this.running) return;

    var currentCallStack = debug.wrapCallFrames(this.exec_state_, stackTraceLimit, 3);
    var callFrames = InjectedScript.wrapCallFrames(currentCallStack);
    // TODO
    // var asyncStackTrace = ...

    response.body = callFrames;
  }

  function _restartFrame(args, response, InjectedScript, DebuggerScript) {
    if (this.running_) return;

    var callFrameId = args[0];
    var currentCallStack = debug.wrapCallFrames(this.exec_state_, stackTraceLimit, 3);
    InjectedScript.restartFrame(currentCallStack, callFrameId);
    _getBacktrace.call(this, args, response, InjectedScript);
  }

  function _setBreakpointsActive(args, response, InjectedScript, DebuggerScript) {
    DebuggerScript.setBreakpointsActivated(this.exec_state_, { enabled: args[0] });
  }

  function _pause(args, response, InjectedScript) {
    if (!this.running_) return;

    debug.setPauseOnNextStatement(true);
  }

  function _continue(args, response, InjectedScript) {
    if (this.running_) return;

    debug.releaseObjectGroup('backtrace');
    debug.emitEvent('Debugger.resumed');
    response.running = true;
  }

  function _stepOver(args, response, InjectedScript, DebuggerScript) {
    if (this.running_) return;

    var frame = debug.wrapCallFrames(this.exec_state_, 1, 0);
    if (frame.isAtReturn) {
      return _stepInto(args, response, InjectedScript, DebuggerScript);
    }

    _continue(args, response, InjectedScript);
    DebuggerScript.stepOverStatement(this.exec_state_);
  }

  function _stepInto(args, response, InjectedScript, DebuggerScript) {
    if (this.running_) return;

    _continue(args, response, InjectedScript);
    DebuggerScript.stepIntoStatement(this.exec_state_);
  }

  function _stepOut(args, response, InjectedScript, DebuggerScript) {
    if (this.running_) return;

    _continue(args, response, InjectedScript);
    DebuggerScript.stepOutOfFunction(this.exec_state_);
  }

  function matches(url, pattern, isRegex) {
    return isRegex ? new RegExp(pattern).test(url) : url == pattern;
  }
};
