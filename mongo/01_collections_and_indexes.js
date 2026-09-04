

const fs = require("fs");
const path = require("path");


function loadSchemaMap() {
    const candidates = [
        path.join(process.cwd(), "docs", "mongo_schema_map.json"),
        path.join(process.cwd(), "..", "docs", "mongo_schema_map.json"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            print(`[01] schema map: ${p}`);
            return JSON.parse(fs.readFileSync(p, "utf8"));
        }
    }
    throw new Error(
        "docs/mongo_schema_map.json not found. Run this script from the repository root:\n" +
        "    mongosh bitestream mongo/01_collections_and_indexes.js"
    );
}

const SCHEMA = loadSchemaMap();
const dropFirst = (typeof DROP_FIRST !== "undefined") && DROP_FIRST === true;

print("");
print("=== 01_collections_and_indexes.js ===");
print(`database   : ${db.getName()}`);
print(`drop first : ${dropFirst}`);
print("");


function keysFromSpec(pairs) {
    const keys = {};
    for (const [field, direction] of pairs) keys[field] = direction;
    return keys;
}

for (const [name, spec] of Object.entries(SCHEMA.collections)) {
    print(`--- ${name} ---`);

    const exists = db.getCollectionNames().includes(name);

    if (dropFirst && exists) {
        db.getCollection(name).drop();
        print("    dropped");
    }


    if (db.getCollectionNames().includes(name)) {
        db.runCommand({
            collMod: name,
            validator: spec.validator,
            validationLevel: spec.validationLevel,
            validationAction: spec.validationAction,
        });
        print("    validator applied via collMod (existing data preserved)");
    } else {
        db.createCollection(name, {
            validator: spec.validator,
            validationLevel: spec.validationLevel,
            validationAction: spec.validationAction,
        });
        print("    created with validator");
    }

    const coll = db.getCollection(name);
    for (const ix of coll.getIndexes()) {
        if (ix.name !== "_id_") coll.dropIndex(ix.name);
    }

    for (const ixSpec of spec.indexes) {
        const keys = keysFromSpec(ixSpec.keys);
        const opts = Object.assign({ name: ixSpec.name }, ixSpec.options || {});
        coll.createIndex(keys, opts);

        const flags = [];
        if (opts.unique) flags.push("unique");
        if (opts.expireAfterSeconds !== undefined) {
            flags.push(`TTL ${opts.expireAfterSeconds}s`);
        }
        if (Object.values(keys).includes("2dsphere")) flags.push("2dsphere");
        print(`    index ${ixSpec.name.padEnd(24)} ${JSON.stringify(keys)}` +
              (flags.length ? `  [${flags.join(", ")}]` : ""));
    }
    print("");
}


print("=== verification ===");

const pingIx = db.DriverPings.getIndexes();

const geo = pingIx.find((i) => i.key && i.key.location === "2dsphere");
if (!geo) throw new Error("FAIL: no 2dsphere index on DriverPings.location");
print(`  2dsphere on DriverPings.location : OK (${geo.name})`);

const ttl = pingIx.find((i) => i.expireAfterSeconds !== undefined);
if (!ttl) throw new Error("FAIL: no TTL index on DriverPings");
if (ttl.expireAfterSeconds !== 7200) {
    throw new Error(`FAIL: TTL is ${ttl.expireAfterSeconds}s, the brief requires 7200`);
}

if (Object.keys(ttl.key).length !== 1) {
    throw new Error("FAIL: a TTL index must be single-field");
}
print(`  TTL 7200s on DriverPings.created_at : OK (${ttl.name})`);

for (const [name, spec] of Object.entries(SCHEMA.collections)) {
    const info = db.getCollectionInfos({ name })[0];
    const hasValidator = !!(info && info.options && info.options.validator);
    if (!hasValidator) throw new Error(`FAIL: ${name} has no validator`);
    print(`  ${name.padEnd(12)} validator: OK   docs: ${db.getCollection(name).countDocuments()}`);
}

print("");
print("--- 01_collections_and_indexes.js complete");
