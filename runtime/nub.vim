scriptversion 4

let s:save_cpo = &cpo
set cpo&vim

function s:Connected() abort
  if !exists( 's:dap' )
    return v:false
  endif

  if ch_status( s:dap ) != 'open'
    return v:false
  endif

  return v:true
endfunction

function! DebugHook() abort
  if !s:Connected()
    return ''
  endif

  " We have been called to get a command to execute due to a breakpoint
  call ch_sendexpr( s:dap, #{ Message_type: "Notify",
                            \ Function: "Break",
                            \ Arguments: #{ Reason: "Breakpoint" } } )

  let cmd = {}
  while empty( cmd ) && s:Connected()
    call ch_log( "Waiting for command from debugger..." )
    " Wait until we get a command, but handle other requests.
    let cmd = ch_evalexpr( s:dap, #{ Message_type: "Request",
                                   \ Function: "GetCommand" },
                                   \ #{ timeout: 10000 } )
  endwhile

  call ch_log( "Got command from debugger: " .. string( cmd ) )

  " step in
  " step out
  " step over
  " continue
  " etc. - any command actually
  return cmd.Arguments.Command
endfunction

function! s:OnChannelClosed( chan ) abort
  call ch_log( "Debugger disconnected. It probably just crashed" )
  unlet s:dap
endfunction

function! s:OnChannelMessage( chan, msg ) abort
  " TODO/FIXME: If i change a:msg to msg here, vim crashes
  call ch_log( "Got a message without a callback: " .. string( a:msg ) )

  if a:msg.Function ==# 'clearLineBreakpoints'
    let breakpoints = split( execute( 'breaklist' ), "\n" )

    if len( breakpoints ) == 1 && breakpoints[ 0 ] ==# 'No breakpoints defined'
      let breakpoints = []
    endif

    for breakpoint in breakpoints
      let matches = matchlist(
            \ breakpoint,
            \ '\v\C^\s*([0-9]+)\s+(\w+)\s+(.*)\s+line\s+([0-9]+)$' )

      call ch_log( 'Breakpoint (' .. breakpoint .. '): ' .. string( matches ) )

      if len( matches ) >= 5
        let [ ignore, id, type, name, line ] = matches[ : 4 ]
        if type ==# 'file' && name ==# a:msg.Arguments.file
          execute 'breakdel ' .. idx
        endif
      else
        throw "Could not parse breakpoint "
              \ .. breakpoint
              \ .. "( " .. string( matches ) .. ")"
      endif
    endfor

    call ch_sendexpr( a:chan, #{
          \   Message_type: 'Reply',
          \   Function: a:msg.Function,
          \   Arguments: #{
          \      request_id: a:msg.Arguments.request_id,
          \   }
          \ } )

    return
  endif

  if a:msg.Function ==# 'setLineBreakpoint'
    " Silent by default in a chan callback
    execute 'breakadd file '
          \ .. a:msg.Arguments.line
          \ .. ' '
          \ .. a:msg.Arguments.file

    echom "Added breakpoint at" a:msg.Arguments.file ":" a:msg.Arguments.line

    call ch_sendexpr( a:chan, #{
          \   Message_type: 'Reply',
          \   Function: a:msg.Function,
          \   Arguments: #{
          \      request_id: a:msg.Arguments.request_id,
          \   }
          \ } )
    return
  endif

  if a:msg.Function ==# "stackTrace"
    let stack = debug_getstack()
    " If we're paused in the debugger, top of stack is always the DebugHook, so
    " pop that here as the user doesn't know about it, or care
    if len( stack ) > 0 && stack[ 0 ].name == 'DebugHook'
      let stack = stack[ 1: ]
    endif

    call ch_sendexpr( a:chan, #{
          \   Message_type: 'Reply',
          \   Function: a:msg.Function,
          \   Arguments: #{
          \      request_id: a:msg.Arguments.request_id,
          \      frames: stack,
          \   }
          \ } )
    return
  endif

  if a:msg.Function ==# "variables"
    let vars = debug_getvariables( a:msg.Arguments.stack_level,
                                 \ a:msg.Arguments.scope )

    call ch_sendexpr( a:chan, #{
          \   Message_type: 'Reply',
          \   Function: a:msg.Function,
          \   Arguments: #{
          \      request_id: a:msg.Arguments.request_id,
          \      vars: vars,
          \   }
          \ } )
    return
  endif

  if a:msg.Function ==# 'evaluate'
    " FIXME: This ignores Arguments.stack_level and therefore doesn't work for
    " local vars etc.
    try
      let result = eval( a:msg.Arguments.expression )
    catch /.*/
      let result = v:exception
    endtry

    " FIXME: type( result ) returns a number whereas the vars result is a string
    " naming the type.
    call ch_sendexpr( a:chan, #{
          \   Message_type: 'Reply',
          \   Function: a:msg.Function,
          \   Arguments: #{
          \      request_id: a:msg.Arguments.request_id,
          \      result: result,
          \      type: type( result ),
          \   }
          \ } )
    return
  endif

  " pause
endfunction

function! s:Connect() abort
  if exists( '$VIMTROSPECT_PORT' )
    let debugger_address = $VIMTROSPECT_PORT
  else
    let debugger_address = 'localhost:4321'
  endif

  if exists( '$VIMTROSPECT_WAIT' )
    let waittime = 999999
  else
    let waittime = 10000
  endif

  let s:log_file = expand( '~/.vimtrospect.log' )
  call ch_logfile( s:log_file, 'w' )

  echom 'Vimtrospector: Starting up vim with PID:' getpid()
  echom "Connecting to debugger at " .. debugger_address
  echom "Logging messages to " .. s:log_file

  try
    let s:dap = ch_open( debugger_address, #{
          \   mode: 'json',
          \   callback: funcref( 's:OnChannelMessage' ),
          \   close_cb: funcref( 's:OnChannelClosed' ),
          \   drop: 'never',
          \   waittime: waittime,
          \ } )
  catch /E902/
    echom "Unable to connect to " .. debugger_address .. "..."
    sleep 500m
  endtry

  if !s:Connected()
    echom 'Unable to connect to the debug adapter'
    return
  endif

  echom "Connected to the debug adapter, waiting for init."

  let cmd = {}
  while empty( cmd ) && s:Connected()
    call ch_log( "Waiting for command from debugger..." )
    " Wait until we get a completion, but handle other requests.
    let cmd = ch_evalexpr( s:dap, #{ Message_type: "Request",
                                   \ Function: "Initialize" },
                                   \ #{ timeout: 10000 } )
  endwhile

  echom "Got debugger init response... booting"

endfunction

call s:Connect()

let &cpo = s:save_cpo
