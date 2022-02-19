export const crackingTools = [
    "BruteSSH.exe",
    "FTPCrack.exe",
    "relaySMTP.exe",
    "HTTPWorm.exe",
    "SQLInject.exe"]


/** @param {import("../../..").NS } ns */
export function toolCount(ns) {
    let count = 0
    crackingTools.forEach(name => ns.fileExists(name)?count++:count+=0)    
    return count
}

export function tools(){
    return crackingTools
}