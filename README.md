# Vim debug adapter

This project aims to provide a debug adapter (DAP) for vimscript debugging.

It's primary use-case is to be used with [vimspector](https://puremourning.github.io/vimspector-web).

# Status

It is work in progress, in the "experriment" stage, and requires Vim changes
from my fork.

The proof of concept can:

* Step through, etc.
* Display locals
* Display the call stack in cluding sources files and user functions

There are tons of other things that it doesn't do. 

Everything can change. Don't use this for anything.

# Demo

This is the status of the proof of concept:

![POC](https://files.gitter.im/Valloric/ycmd/vhCg/vimspector-vimscript-POC-vars.gif)
