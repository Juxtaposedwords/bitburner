import fs from 'fs';
import path from 'path';
import protobuf from 'protobufjs';
import Handlebars from 'handlebars';
import chokidar from 'chokidar';

const SRC_DIR = './src';
const TEMPLATE_FILE = './protos/service.hbs';
const REGISTRY_FILE = './protos/port_registry.json';

// Keeps reply ports (ns.pid-based) clear of low, statically-assigned service ports.
const REPLY_PORT_OFFSET = 1000;

// Netscript ports are a single global namespace, so every service needs a
// port that's unique across the whole project. Ports below this are left
// free for other conventions (e.g. hack/grow/weaken scripts).
const BASE_PORT = 10;

console.log("[proto] Booting up gRPC compiler...");

function loadRegistry() {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
}

function saveRegistry(registry) {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n');
}

// Ports are assigned once per service and persisted, so restarting the
// generator (or adding new services) never reassigns an existing service's
// port or hands out one already claimed by another service.
function assignPort(registry, key) {
    const existing = registry[key];
    if (existing !== undefined) return existing;

    const used = new Set(Object.values(registry));
    let port = BASE_PORT;
    while (used.has(port)) port++;

    registry[key] = port;
    saveRegistry(registry);
    return port;
}

const portRegistry = loadRegistry();

function getProtoFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const stat = fs.statSync(path.join(dir, file));
        if (stat.isDirectory()) {
            getProtoFiles(path.join(dir, file), fileList);
        } else if (file.endsWith('.proto')) {
            fileList.push(path.join(dir, file));
        }
    }
    return fileList;
}

async function processFile(filePath) {
    const root = await protobuf.load(filePath);
    root.resolveAll();
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const templateSource = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
    const template = Handlebars.compile(templateSource, { noEscape: true });
    
    // Extract the package name using Regex
    const packageMatch = fileContent.match(/package\s+([^;]+);/);
    // Fallback to service name if no package is defined
    const packageName = packageMatch ? packageMatch[1].trim() : 'unknown_package';
    
    const outputDir = path.dirname(filePath);

    const services = [];
    function findServices(node) {
        if (node instanceof protobuf.Service) services.push(node);
        else if (node.nestedArray) node.nestedArray.forEach(findServices);
    }
    findServices(root);

    for (const service of services) {
        const registryKey = `${packageName}.${service.name}`;
        const defaultPort = assignPort(portRegistry, registryKey);

        const context = {
            serviceName: service.name,
            defaultPort,
            replyPortOffset: REPLY_PORT_OFFSET,
            methods: [],
            messages: [],
            enums: [],
        };
        const visitedMessages = new Set();
        const visitedEnums = new Set();
        const queue = [];

        for (const [name, method] of Object.entries(service.methods)) {
            context.methods.push({ name, requestType: method.requestType, responseType: method.responseType });
            queue.push(method.requestType, method.responseType);
        }

        // Messages can reference other messages/enums; walk the closure so every
        // type touched by a request/response ends up defined in the output.
        while (queue.length > 0) {
            const typeName = queue.shift();
            if (visitedMessages.has(typeName)) continue;
            visitedMessages.add(typeName);

            const type = root.lookupType(typeName);
            const fields = type.fieldsArray.map(field => {
                let tsType;
                if (field.resolvedType instanceof protobuf.Enum) {
                    tsType = field.resolvedType.name;
                    if (!visitedEnums.has(tsType)) {
                        visitedEnums.add(tsType);
                        context.enums.push({
                            name: tsType,
                            values: Object.entries(field.resolvedType.values).map(([name, value]) => ({ name, value })),
                        });
                    }
                } else if (field.resolvedType) {
                    tsType = field.resolvedType.name;
                    queue.push(tsType);
                } else if (field.type === 'string') {
                    tsType = 'string';
                } else if (field.type === 'bool') {
                    tsType = 'boolean';
                } else {
                    tsType = 'number';
                }
                return {
                    name: field.name,
                    optional: field.optional ? '?' : '',
                    type: field.repeated ? `${tsType}[]` : tsType,
                };
            });
            context.messages.push({ name: typeName, fields });
        }

        // Output file is now strictly based on the package name
        const outputFile = path.join(outputDir, `${packageName}.ts`);
        fs.writeFileSync(outputFile, template(context));
        console.log(`[proto] Generated ${outputFile}`);
    }
}

export async function buildProtos() {
    console.log("[proto] Scanning for .proto files...");
    const files = getProtoFiles(SRC_DIR);
    if (files.length === 0) console.log("[proto] No .proto files found in /src.");
    
    for (const file of files) {
        await processFile(file).catch(err => console.error(`[proto] Failed to process ${file}:`, err));
    }
}

buildProtos().catch(console.error);

if (process.argv.includes('--watch')) {
    console.log(`[proto] Watching ${SRC_DIR} for .proto files...`);
    
    const watchPaths = [
        `${SRC_DIR}/**/*.proto`,
        `${SRC_DIR}/*.proto`
    ];

    chokidar.watch(watchPaths, {
        persistent: true,
        ignoreInitial: true
    }).on('change', (filePath) => {
        console.log(`[proto] Saved ${filePath}. Rebuilding...`);
        processFile(filePath).catch(console.error);
    }).on('add', (filePath) => {
        console.log(`[proto] New file ${filePath}. Rebuilding...`);
        processFile(filePath).catch(console.error);
    });
}