# bitburner

## Setup
### Treat NS work as JS files
1. Open the CMD palette (Power + CTRL + P) 
2. Type "Open user Settings" and select the option
3. In the search bar at the top type "Files: Association" and select "Files(1)"
4. Click "Add Item" and enter:
   * item: `*.ns`
   * value: `javascript`

### Install bitburner extension
1. Find your extensions folder
   1.  Open the CMD palette (Power + CTRL + P) and type "Open Extension Folder"
2. Use git to clone https://github.com/bitburner-official/bitburner-vscode into the extension directory
3. Restart VSCode
4. Configure the extension:
   1. Open the extension extension by either :
      *  using "CTRL + SHIFt + X" 
      *  Open the CMD palette (Power + CTRL + P)  and type "Show installed extensions"
   2. Select the gear icon (⚙) by bitburner connector extension and select 'extension settings'
   3. Set the following settings:
      * **Script root** : `./out/`
         * This way we dont' export any github tooling niceities
      * **Auth Token**: 
         * Copy the auth token by opening bit burnern and folllowing: 
            * `API Server` -> `Copy Auth Token`


## Configuration information

* Files in the `out/` directory are written to the desktop.
