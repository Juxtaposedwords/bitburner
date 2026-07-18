# Setting all this crap out

Opionated approach here/reminder of how to set up a  linux subsystem with VSCode so you get linux Quality of life + Windows. 

I have added a Visual Studio task, which runs the `npm run watch` at start time of the workspace. 

**NOTE:** You will still have to connect to remote API at start time with each run of BitBurner. 


## 1. Set up WSL & VS Code

### 1.A Set up WSL
1. Set up WSL to a linux subsystem 
  * Powershell(Admin): `wsl.exe --install Ubuntu`
1. Set up the WSL CLI as the default CLI for VS Code
  * CMD + P ==> `Terminal: Select Default Profile` ==> Select the WSL for Ubuntu
1. Open up the `WSL` via your windows Launcher
1. Copy your windows SSH keys you have for your windows:
    ```bash
    #!/bin/bash

    # Ask Windows for the current username and strip the invisible carriage return (\r)
    WIN_USER=$(cmd.exe /c echo %USERNAME% 2>/dev/null | tr -d '\r')

    # Copy the SSH folder from the dynamic Windows user path into the Linux home directory
    cp -r "/mnt/c/Users/$WIN_USER/.ssh" ~/

    # Restrict access to the main SSH folder so only the current Linux user can open it
    chmod 700 ~/.ssh

    # Strip read and write permissions from all other users for the files inside the folder
    chmod 600 ~/.ssh/*

    # Start the background SSH agent and evaluate its environment variables for the current shell
    eval "$(ssh-agent -s)"

    # Find any file in the .ssh folder containing "PRIVATE KEY" and load it into the agent
    for key in $(grep -lr "PRIVATE KEY" ~/.ssh); do
        ssh-add "$key"
    done
    ```
1. Copy your windows Git configs into WSL:
    ```bash
    #!/bin/bash

    # Ask Windows for the current username and strip the invisible carriage return (\r)
    WIN_USER=$(cmd.exe /c echo %USERNAME% 2>/dev/null | tr -d '\r')

    # Check if the Windows .gitconfig file actually exists before trying to copy it
    if [ -f "/mnt/c/Users/$WIN_USER/.gitconfig" ]; then
        # Copy the global Git configuration file from Windows to the Linux home directory
        cp "/mnt/c/Users/$WIN_USER/.gitconfig" ~/.gitconfig
        
        # Print a success message to the terminal
        echo "Windows Git configuration successfully copied to WSL!"
    else
        # Warn the user if no Windows Git configuration was found
        echo "No .gitconfig found in C:\Users\\$WIN_USER"
    fi
    ```
2. Clone your repo into the WSL dirctory.  From the WSL client, now run 
    ```bash
    cd ~/Development/
    git clone git@github.com:Juxtaposedwords/bitburner.git
    ```
3. Open VS Code with WSL
   1. Open VS Code 
   2. `CMD` + `SHIFT` + `P` ==> `WSL: Connnect to WSL`
   3. Select the Ubuntu WSL
   4. Open `~/Development/bitburner` as the workspace
     * _This will open the workspace based off the linux subsystem. We have to do this to ensure node will pick up the changes we make._
 
## 2. Set up node

1. Use `CMD` +  `~` to open the terminal (look at you go). Run the following in the Linut wsl
  * Install NPM. From your WSL run:
      ```bash
      sudo apt update && sudo apt install nodejs npm
      ``` 
  * Get the BitBurner TypeScript Template
    ```bash
    # 1. Download the tarball (since Linux loves tarballs)
    curl -L https://github.com/bitburner-official/typescript-template/archive/refs/heads/main.tar.gz -o template.tar.gz
    # 2. Extract it to overwrite your files
    tar -xzf template.tar.gz --strip-components=1
    # 3. Clean up
    rm template.tar.gz
    ```
  
  * Install it all and start listener
    ```bash
    npm install
    # Starts the NPM listener
    npm run watch
    ```
  * Connnect bitburner
     * Get the hostname by either:
       * Powershell(admin): 
        ```powershell
        wsl.exe --distribution ubuntu hostname -I
        ```
      * WSL 
        ```bash
        hostname -I
        ```          
     * In BitBurner go to Options -> Remote API and then:

        | Setting | Value |
        |---|---|
        | `Port` | 12525 |
        | `Hostname` | {result of the prior step} |
        | `ReconnectionDelay` | 5 |

 

# Typescript template for Bitburner's Remote File API

The official template for synchronizing Typescript/Javascript from your computer to the game.

[Step by step install](BeginnersGuide.md)

[Docker install guide](DockerGuide.md) (optional) 

[Learn more about Typescript](https://www.typescriptlang.org/docs/)

## About

This template uses the Typescript compiler and the Remote File API system to synchronize Typescript to your game.
Due to the usage of the RFA system, it works with Web and Electron (Steam) versions of the game.

## Prerequisites

[Node.js](https://nodejs.org/en/download/) is needed for compiling typescript and installing dependencies.

[See here for step by step installation](BeginnersGuide.md) if you'd like help with installing Node and/or connecting to the game.

Alternatively see [Docker install guide](DockerGuide.md) (optional) that installs nodejs and the Remote File API in an isolated container.

## Quick start

Download the template to your computer and install everything it requires:
```
git clone https://github.com/bitburner-official/typescript-template
cd typescript-template
npm i
```

### How to use this template

Write all your typescript source code in the `/src` directory

To autocompile and send changed files as you save, run `npm run watch` in a terminal.
Have it running in the background so that it all happens automatically.

For Bitburner to receive any files, you need to enter the port `npm run watch` logs to the terminal
in the Remote API section of the game settings, and press the connect button.

[See here for step by step installation](BeginnersGuide.md) if you'd like help with installing Node and/or connecting to the game.

Alternatively see [Docker install guide](DockerGuide.md) (optional) that installs nodejs and the Remote File API in an isolated container.

## Advanced
### Imports

To ensure both the game and typescript have no issues with import paths, your import statements should follow a few formatting rules:

- Paths must be absolute from the root of `src/`, which will be equivalent to the root directory of your home drive
- Paths must contain no leading slash
- Paths must end with no file extension

#### Examples:

To import `helperFunction` from the file `helpers.ts` located in the directory `src/lib/`:

```js
import { helperFunction } from "lib/helpers";
```

To import all functions from the file `helpers.ts` located in the `src/lib/` directory as the namespace `helpers`:

```js
import * as helpers from "lib/helpers";
```

To import `someFunction` from the file `main.ts` located in the `src/` directory:

```js
import { someFunction } from "main";
```

### Debugging

For debugging bitburner on Steam you will need to enable a remote debugging port. This can be done by rightclicking bitburner in your Steam library and selecting properties. There you need to add `--remote-debugging-port=9222` [Thanks @DarkMio]

### Using React
Some `ns` functions, like [`ns.printRaw()`](https://github.com/bitburner-official/bitburner-src/blob/dev/markdown/bitburner.ns.printraw.md) allows you to render React components into the game interface. 

The game already exposes the `React` and `ReactDOM` objects globally, but in order to work with strongly typed versions in `.ts` files, you can use the included typings. To do this, use the following import:

`import React, { ReactDOM } from '@react'`

Support for jsx is also included, so if you use the `.tsx` file ending, you can do something like:

```ts
import { NS } from '@ns';
import React from '@react';

interface IMyContentProps {
  name: string
}

const MyContent = ({name}: IMyContentProps) => <span>Hello {name}</span>;

export default async function main(ns: NS){
  ns.printRaw(<MyContent name="Your name"></MyContent>);
}
```
