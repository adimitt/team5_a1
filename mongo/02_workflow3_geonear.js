
function execStatsOf(explainDoc) {
    if (explainDoc.executionStats) return explainDoc.executionStats;
    if (explainDoc.stages && explainDoc.stages.length) {
        const first = explainDoc.stages[0];
        for (const key of ["$cursor", "$geoNearCursor"]) {
            if (first[key] && first[key].executionStats) return first[key].executionStats;
        }
    }
    return null;
}


function stageNames(node, acc) {
    acc = acc || [];
    if (!node || typeof node !== "object") return acc;
    if (node.stage) acc.push(node.stage);
    for (const child of [node.inputStage].concat(node.inputStages || [])) {
        if (child) stageNames(child, acc);
    }
    return acc;
}

const RID = (typeof RESTAURANT_ID !== "undefined") ? RESTAURANT_ID : 1;
const RADIUS_M = (typeof RADIUS !== "undefined") ? RADIUS : 5000;

const N_DRIVERS = (typeof DRIVERS !== "undefined") ? DRIVERS : 1;
const WANT_EXPLAIN = (typeof EXPLAIN !== "undefined") && EXPLAIN === true;

print("");
print("=== Workflow 3 : nearest active driver ===");


const menu = db.Menus.findOne({ restaurant_id: RID }, { name: 1, city: 1, location: 1 });
if (!menu) {
    throw new Error(
        `No Menus document for restaurant_id ${RID}. ` +
        `Run data_generation/mongo_seeder.py first.`
    );
}
const origin = menu.location;

print(`restaurant : ${RID} - ${menu.name} (${menu.city})`);
print(`origin     : [lng ${origin.coordinates[0].toFixed(5)}, ` +
      `lat ${origin.coordinates[1].toFixed(5)}]`);
print(`radius     : ${RADIUS_M} m`);
print(`returning  : ${N_DRIVERS === 1 ? "the single closest active driver (per the brief)"
                                      : N_DRIVERS + " nearest active drivers"}`);
print("");


const pipeline = [
    {
        $geoNear: {
            near: origin,
            distanceField: "distance_m",   
            maxDistance: RADIUS_M,
            spherical: true,               
            key: "location",              
            query: { status: "ACTIVE" }, 
        },
    },


    { $sort: { driver_id: 1, distance_m: 1 } },
    {
        $group: {
            _id: "$driver_id",
            distance_m: { $first: "$distance_m" },
            location:   { $first: "$location" },
            seen_at:    { $first: "$created_at" },
            speed_kmph: { $first: "$speed_kmph" },
            order_id:   { $first: "$order_id" },
            ping_count: { $sum: 1 },
        },
    },


    { $sort: { distance_m: 1 } },

    { $limit: N_DRIVERS },
    {
        $project: {
            _id: 0,
            driver_id: "$_id",
            distance_m: { $round: ["$distance_m", 1] },
            eta_minutes: {

                $round: [{ $divide: ["$distance_m", 366.7] }, 1],
            },
            speed_kmph: 1,
            busy_with_order: "$order_id",
            pings_in_radius: "$ping_count",
            seen_at: 1,
        },
    },
];


if (WANT_EXPLAIN) {

    print(JSON.stringify(
        db.DriverPings.explain("executionStats").aggregate(pipeline), null, 2));
} else {
    const t0 = Date.now();
    const results = db.DriverPings.aggregate(pipeline).toArray();
    const ms = Date.now() - t0;

    print(`--- ${results.length} ${results.length === 1 ? "driver" : "drivers"}` +
          ` returned from within ${RADIUS_M} m  (${ms} ms)`);
    print("");
    if (results.length === 0) {
        print("  NOTHING FOUND. The two usual causes:");
        print("   1. coordinates stored as [lat, lng] instead of [lng, lat]");
        print("   2. the TTL reaper has emptied DriverPings - re-run");
        print("      python3 data_generation/mongo_seeder.py --pings-only");
    } else {
        print("  driver   distance      ETA   speed        last seen");
        print("  ---------------------------------------------------------------");
        for (const r of results) {
            print(
                "  " + String(r.driver_id).padStart(6) +
                String(r.distance_m + " m").padStart(11) +
                String(r.eta_minutes + " min").padStart(9) +
                String(r.speed_kmph + " km/h").padStart(11) +
                "   " + r.seen_at.toISOString()
            );
        }
    }


    const total = db.DriverPings.estimatedDocumentCount();
    const exec = execStatsOf(db.DriverPings.explain("executionStats").aggregate(pipeline));

    print("");
    if (exec) {
        const allStages = stageNames(exec.executionStages);

        const counted = {};
        for (const st of allStages) counted[st] = (counted[st] || 0) + 1;
        const stages = Object.entries(counted)
            .map(([st, n]) => (n > 1 ? `${st} x${n}` : st));
        print(`  collection size    : ${total.toLocaleString()} pings`);
        print(`  documents examined : ${exec.totalDocsExamined.toLocaleString()}`);
        print(`  keys examined      : ${exec.totalKeysExamined.toLocaleString()}`);
        print(`  selectivity        : 1 in ${Math.round(total / Math.max(exec.totalDocsExamined, 1))}`);
        print(`  execution time     : ${exec.executionTimeMillis} ms`);
        print(`  plan stages        : ${stages.join(", ")}`);

        // Assert the proof rather than eyeballing it.
        if (!allStages.includes("GEO_NEAR_2DSPHERE")) {
            throw new Error("FAIL: the 2dsphere index was not used (no GEO_NEAR_2DSPHERE stage)");
        }
        if (allStages.includes("COLLSCAN")) {
            throw new Error("FAIL: the plan contains a COLLSCAN");
        }
        print(`  verdict            : GEO_NEAR_2DSPHERE present, no COLLSCAN -> index confirmed`);
    }
}

print("");
print("--- Workflow 3 complete");
