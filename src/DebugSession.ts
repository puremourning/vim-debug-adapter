import * as DA from 'vscode-debugadapter'
import { logger, Logger } from 'vscode-debugadapter'
import { DebugProtocol } from 'vscode-debugprotocol'
import * as net from 'net'
import * as readline from 'readline'
import * as path from 'path'

const NUB = path.resolve( __dirname, '..', 'runtime', 'nub.vim' )
const DEFAULT_PORT = 4321;

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  vim?: string,
  args?: string[],
  env?: { [key: string]: string },
  cwd?: string,
  port?: number
  trace?: boolean,
};

interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  port?: number
  trace?: boolean,
};

interface VimRequest {
  id: number,
  msg: VimMessage
};

interface VimMessage {
  Message_type: string,
  Function: string,
  Arguments?: any
};

interface PendingRequest {
  resolve( result: VimMessage ): void;
  reject( error: string ): void;
};

interface VimFrame {
  stack_level: number,
  name: string,
  line: number,
  source_line?: number,
  source_file?: string,
  type: "UFUNC" | "SCRIPT" | "AUCMD" | string
};

interface VimVar {
  name: string,
  type: string,
  value: string
};

class Variable extends DA.Variable {
  public constructor( name: string, value: string, public type: string )
  {
    super( name, value );
  }
};

interface VariableRef {
  stack_level: number,
  scope: string
};

class Scope extends DA.Scope {
  constructor( var_refs: VariableRef[],
               name: string,
               level: number,
               scope: string,
               expensive: boolean = true ) {
    let idx = var_refs.length;
    var_refs.push( { scope: scope, stack_level: level } );
    super( name, idx, expensive );
  }
}

export class VimDebugSession extends DA.LoggingDebugSession {

  private vim?: net.Socket;
  private vim_command_request?: VimRequest;
  private next_request_id = 0;
  private vim_requests = new Map<number, PendingRequest>();
  private did_start_vim = false;
  private var_refs = new Array<VariableRef>();

  public constructor() {
    super();
    this.setDebuggerLinesStartAt1( true );
    this.setDebuggerColumnsStartAt1( true );
    this.setDebuggerPathFormat( 'path' );
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments ): void {

    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // the adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsFunctionBreakpoints = true;
    response.body.supportTerminateDebuggee = true;
    response.body.supportsTerminateRequest = true;

    this.sendResponse(response);
  }

  // launchRequest
  protected launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments ) {

    logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
                 false);

    this.attachToVim( args.port || DEFAULT_PORT );

    // Launch Vim
    this.runInTerminalRequest( {
      args: [ args.vim || 'vim', '-N', '--cmd', 'source ' + NUB ].concat(
        args.args || [] ),
      env: args.env,
      cwd: args.cwd || '',
      kind: 'integrated',
      title: 'Vim'
    }, -1, ( run_in_terminal_response ) => {
      this.did_start_vim = true;
      this.sendResponse(response);
    } );
  }

  // attachRequest
  protected attachRequest(
    response: DebugProtocol.AttachResponse,
    args: AttachRequestArguments ) {

    logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
                 false);

    this.attachToVim( args.port || DEFAULT_PORT );
    this.did_start_vim = false;
    this.sendResponse(response);
  }

  protected async attachToVim( port: number ) {
    // Start the Vim server
    let server = net.createServer( (c) => {
      this.vim = c;
      c.setEncoding( 'utf8' );
      readline.createInterface( { input: c } )
              .on( 'line', this.onVimData.bind( this ) )
              .on( 'close', this.onVimConnectionClosed.bind( this ) );

      // We will send the "InitializedEvent" later, when the NUB requests the
      // "Initialize" from us. The way this works is:
      //
      // Client    Adapter         Vim
      // |             |             |
      // LAUNCH {{{
      // | launch----->|             |
      // |       <-----runInTerm     |
      // | start-------------------->o
      // |            |              |<-openSocket
      // |       <----launchResponse |
      // }}} or ATTACH {{{
      // |            |              |<-openSocket
      // | attach----->|             |
      // }}}
      // |             |connect----->|
      // |             | (*here)
      // |             |    <--------Request(Initialize)
      // |       <----InitializedEvent
      // | bkpnt------>|------------>|
      // | bkpnt------>|------------>|
      // | bkpnt------>|------------>|
      // | init done-->|    -------->|Response(Initialize)
    } );
    server.maxConnections = 1;
    server.listen( port );
  }


  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments ) {

    const breakpoints = args.breakpoints || [];
    response.body = response.body || {};
    response.body.breakpoints = [];

    var promises : Promise<VimMessage>[] = [];

    promises.push( this.requestFromVim( {
      Message_type: "Request",
      Function: "clearLineBreakpoints",
      Arguments: {
        'file': args.source.path,
      }
    } ) )

    for ( const bp of breakpoints ) {
      promises.push( this.requestFromVim( {
        Message_type: "Request",
        Function: "setLineBreakpoint",
        Arguments: {
          'file': args.source.path,
          'line': bp.line
        }
      } ) )

      response.body.breakpoints.push(
        new DA.Breakpoint( true,
                           bp.line,
                           0,
                           new DA.Source( args.source.name!,
                                          args.source.path ) ) );
    }

    await Promise.all( promises );

    this.sendResponse( response );
  }

  protected setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments ) {

    this.sendResponse( response );
  }


  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    args: DebugProtocol.ConfigurationDoneArguments ): void {

    // We should only get this message while vim is wiating for the Initialize
    // exchange (see comment in launch for explanation)
    if (!this.vim_command_request) {
      // For some reason we've initialized before Vim has requested the init
      // message.
      this.sendErrorResponse( response, -200, "Vim is not paused" );
      return;
    } else if (this.vim_command_request.msg.Function !== 'Initialize') {
      // again something else bad has happened, we're in a dodgy state
      this.sendErrorResponse( response, -201, "Vim is not waiting for init" );
      return;
    }

    this.writeResponseToVim( {
      Message_type: 'Reply',
      Function: this.vim_command_request.msg.Function,
    } )

    this.sendResponse( response );
  }

  protected threadsRequest(
    response: DebugProtocol.ThreadsResponse ) {
    response.body = response.body || {};
    response.body.threads = [ { id: 0, name: 'Vim' } ]
    this.sendResponse( response );
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments ) {

    response.body = response.body || {};
    response.body.stackFrames = []

    const vim_stack = await this.requestFromVim( {
      Message_type: "Request",
      Function: "stackTrace",
    } )

    for ( const frame of vim_stack.Arguments[ 'frames' ] as Array<VimFrame> ) {
      response.body.stackFrames.push( {
        id: frame.stack_level,
        name: frame.name,
        line: frame.source_line || frame.line,
        column: 0,
        source: {
          name: frame.source_file ? path.basename( frame.source_file )
                                  : undefined,
          path: frame.source_file || undefined,
        }
      } );
    }

    this.sendResponse( response );
  }

  protected async scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments ) {

    response.body = response.body || {};
    response.body.scopes = [];

    const frameId = args.frameId;

    const vim_stack = await this.requestFromVim( {
      Message_type: "Request",
      Function: "stackTrace",
    } )

    for ( const frame of vim_stack.Arguments[ 'frames' ] as Array<VimFrame> ) {
      if ( frame.stack_level == frameId ) {
        if ( frame.type == "UFUNC" ) {
          response.body.scopes.push( new Scope( this.var_refs,
                                                frame.name,
                                                frameId,
                                                'l',
                                                false ) )
        }

        response.body.scopes.push( new Scope( this.var_refs,
                                              "Script",
                                              frameId,
                                              's' ) )
        response.body.scopes.push( new Scope( this.var_refs,
                                              "Global",
                                              frameId,
                                              'g' ) )
        response.body.scopes.push( new Scope( this.var_refs,
                                              "Buffer",
                                              frameId,
                                              'b' ) )
        response.body.scopes.push( new Scope( this.var_refs,
                                              "Window",
                                              frameId,
                                              'w' ) )
        response.body.scopes.push( new Scope( this.var_refs,
                                              "Tab",
                                              frameId,
                                              't' ) )
        response.body.scopes.push( new Scope( this.var_refs,
                                              "Vim",
                                              frameId,
                                              'v' ) )

        this.sendResponse( response );
        return;
      }
    }

    this.sendErrorResponse( response, -101, "Invalid frame" );
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments ) {

    response.body = response.body || {};
    response.body.variables = [];

    let ref = this.var_refs[ args.variablesReference ];

    const vim_vars = await this.requestFromVim( {
      Message_type: "Request",
      Function: "variables",
      Arguments: {
        'stack_level': ref.stack_level,
        'scope': ref.scope
      }
    } )

    for ( const vim_var of vim_vars.Arguments.vars as VimVar[] ) {
      response.body.variables.push( new Variable( vim_var.name,
                                                  vim_var.value,
                                                  vim_var.type ) );
    }

    this.sendResponse( response );
  }

  protected pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments ) {

    if ( this.vim_command_request ) {
      this.sendErrorResponse( response, -401, "Paused alrady" );
      return;
    }

    this.writeCommandToVim( "ex", "breakint" );
    this.sendResponse( response );
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments ) {

    if (args.terminateDebuggee || this.did_start_vim) {
      if (this.vim_command_request) {
        this.vimCommand( response, ':qa!', );
      } else {
        // vim is currently running, not paused
        this.writeCommandToVim( "ex", "qa!" );
        this.sendResponse( response );
      }
    } else if (this.vim_command_request) {
      this.vimCommand( response, 'quit', );
    }
  }

  protected terminateRequest(
    response: DebugProtocol.TerminateResponse,
    args: DebugProtocol.TerminateArguments ) {

    this.vimCommand( response, ':qa!', );
  }

  private vimCommand( response: DebugProtocol.Response,
                      cmd: string ) {
    if (!this.vim_command_request) {
      this.sendErrorResponse( response, -100, "Vim is not paused" );
      return;
    } else if (this.vim_command_request.msg.Function !== 'GetCommand') {
      this.sendErrorResponse( response, -101, "Vim is not initialized" );
      return;
    }

    this.writeResponseToVim( {
      Message_type: 'Reply',
      Function: this.vim_command_request.msg.Function,
      Arguments: {
        Command: cmd
      }
    } )

    this.sendResponse( response );
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments ) {

    this.vimCommand( response, 'cont' );
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments ) {

    this.vimCommand( response, 'next' );
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments ) {

    this.vimCommand( response, 'step' );
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments ) {

    this.vimCommand( response, 'finish' );
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments ) {

    response.body = response.body || {};

    var vim_response: VimMessage;
    if ( args.context == 'repl' ) {
      vim_response = await this.requestFromVim( {
        Message_type: "Request",
        Function: "execute",
        Arguments: {
          'command': args.expression,
          'stack_level': args.frameId
        }
      } )
    } else {
      // TODO: perhaps we should change this to this.vimCommand( args.expression
      // ); this would make normal debug commands work, though the behaviour
      // would be odd (it would print in the vim not return to the caller).
      //
      // Perhaps if we prefix with `-` or something?
      vim_response = await this.requestFromVim( {
        Message_type: "Request",
        Function: "evaluate",
        Arguments: {
          'expression': args.expression,
          'stack_level': args.frameId
        }
      } )
    }

    response.body.result = vim_response.Arguments[ 'result' ] as string;

    this.sendResponse( response );
  }

  private writeResponseToVim( response: VimMessage ) {
    this.writeToVim( [ this.vim_command_request!.id, response ] );
    this.vim_command_request = undefined;
  }

  private writeCommandToVim( mode: "ex"|"normal", cmd: string ) {
    this.writeToVim( [ mode, cmd ] );
  }

  private writeToVim( obj: any ) {
    const data = JSON.stringify( obj ) + '\n'
    DA.logger.log( "TX Vim: " + data, DA.Logger.LogLevel.Verbose );
    this.vim!.write( data );
  }

  private async requestFromVim( request: VimMessage ): Promise<VimMessage> {
    request.Arguments = request.Arguments || {}
    request.Arguments[ 'request_id' ] = this.next_request_id++;
    return new Promise<VimMessage>( (resolve, reject) => {
      this.vim_requests.set( request.Arguments[ 'request_id' ], {
        resolve: resolve,
        reject: reject
      } );
      this.writeToVim( [ 0, request ] )
    } );
  }

  private onVimData( data: string ) {
    DA.logger.log( "RX Vim: " + data, DA.Logger.LogLevel.Verbose );
    const vim_msg = JSON.parse( data );
    // msg is a list of [ <id>, <actual msg> ]
    const id = vim_msg[ 0 ];
    const msg = vim_msg[ 1 ] as VimMessage;

    switch (msg.Message_type) {
    case 'Notify':
      if (msg.Function === 'Break') {
        this.sendEvent( new DA.StoppedEvent( msg.Arguments[ 'Reason' ], 0 ) );
      }
      break;
    case 'Request':
      if (msg.Function === 'GetCommand') {
        // TODO: i really don't like this; it certainly needs a better name now
        // that it's not just GetCommand; it's really a long-poll style request;
        // maybe call it current_vim_poll_request
        this.vim_command_request = {
          id: id,
          msg: msg,
        };
      } else if (msg.Function === 'Initialize' ) {

        this.vim_command_request = {
          id: id,
          msg: msg
        };

        // TODO: 
        // if ( this.init_promise ) {
        //   this.init_promise.resolve();
        // }
        this.sendEvent( new DA.InitializedEvent() );

      }
      break;
    case 'Reply':
      // resolve a promise for the request ID
      const pending_request = this.vim_requests.get(
        msg.Arguments[ 'request_id' ] );
      if (pending_request) {
        pending_request.resolve( msg );
        this.vim_requests.delete( msg.Arguments[ 'request_id' ] );
      }
      break;
    }
  }

  private onVimConnectionClosed(): void {
    this.sendEvent( new DA.TerminatedEvent() );
    // TOFO/FIXME: Reset all the other stuff too, like did_start_vim
    // Need a Reset() method ?
    this.vim = undefined;
    this.did_start_vim = false;
    this.vim_command_request = undefined;
  }
};
