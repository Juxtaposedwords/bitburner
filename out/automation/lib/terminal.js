/** @param {import("../../..").NS } ns */

// Return a list of all reachable servers.  This will exclude
// purchased servers (if specified) and the server ".", but will
// include "home".
export function run(ns, input) {
// Acquire a reference to the terminal text field
const terminalInput =  document.getElementById("terminal-input");

// Set the value to the command you want to run.
terminalInput.value=input;

// Get a reference to the React event handler.
const handler = Object.keys(terminalInput)[1];

// Perform an onChange event to set some internal values.
terminalInput[handler].onChange({target:terminalInput});

// Simulate an enter press
terminalInput[handler].onKeyDown({keyCode:13,preventDefault:()=>null});
}