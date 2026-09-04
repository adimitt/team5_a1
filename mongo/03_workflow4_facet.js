

const RID = (typeof RESTAURANT_ID !== "undefined") ? RESTAURANT_ID : 7;
const SCOPE_ALL = (typeof SCOPE !== "undefined") && SCOPE === "all";
const WANT_EXPLAIN = (typeof EXPLAIN !== "undefined") && EXPLAIN === true;


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

print("");
print("=== Workflow 4 : multi-faceted review analytics ===");


const since = new Date(Date.now() - 540 * 24 * 3600 * 1000);

const match = SCOPE_ALL
    ? { created_at: { $gte: since } }                       
    : { restaurant_id: RID, created_at: { $gte: since } };  

const menu = db.Menus.findOne({ restaurant_id: RID }, { name: 1, city: 1 });
print(`scope   : ${SCOPE_ALL ? "ALL restaurants" : `restaurant ${RID}` +
      (menu ? ` - ${menu.name} (${menu.city})` : "")}`);
print(`window  : reviews created since ${since.toISOString().slice(0, 10)}`);
print("");


const pipeline = [
    { $match: match },

    {
        $facet: {

            ratingDistribution: [
                { $group: { _id: "$rating", count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
                { $project: { _id: 0, rating: "$_id", count: 1 } },
            ],


            topTags: [
                { $unwind: "$tags" },
                { $group: { _id: "$tags", count: { $sum: 1 } } },
                { $sort: { count: -1, _id: 1 } },   // _id breaks ties deterministically
                { $limit: 10 },                     // bound the fan-out: see the 16 MB note
                { $project: { _id: 0, tag: "$_id", count: 1 } },
            ],


            overall: [
                {
                    $group: {
                        _id: null,
                        avgRating: { $avg: "$rating" },
                        totalReviews: { $sum: 1 },
                        stdDev: { $stdDevPop: "$rating" },
                        minRating: { $min: "$rating" },
                        maxRating: { $max: "$rating" },
                    },
                },
            ],


            sentimentSplit: [
                { $group: { _id: "$sentiment", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $project: { _id: 0, sentiment: "$_id", count: 1 } },
            ],


            monthlyTrend: [
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m", date: "$created_at" } },
                        avgRating: { $avg: "$rating" },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: -1 } },
                { $limit: 6 },
                { $project: { _id: 0, month: "$_id", avgRating: { $round: ["$avgRating", 2] }, count: 1 } },
            ],
        },
    },


    {
        $project: {
            ratingDistribution: 1,
            topTags: 1,
            sentimentSplit: 1,
            monthlyTrend: 1,
            totalReviews: { $ifNull: [{ $arrayElemAt: ["$overall.totalReviews", 0] }, 0] },
            avgRating: { $round: [{ $ifNull: [{ $arrayElemAt: ["$overall.avgRating", 0] }, 0] }, 3] },
            stdDev: { $round: [{ $ifNull: [{ $arrayElemAt: ["$overall.stdDev", 0] }, 0] }, 3] },
            minRating: { $arrayElemAt: ["$overall.minRating", 0] },
            maxRating: { $arrayElemAt: ["$overall.maxRating", 0] },
        },
    },
];


const options = { allowDiskUse: true };


if (WANT_EXPLAIN) {
    print(JSON.stringify(
        db.Reviews.explain("executionStats").aggregate(pipeline, options), null, 2));
} else {
    const t0 = Date.now();
    const out = db.Reviews.aggregate(pipeline, options).toArray()[0];
    const ms = Date.now() - t0;

    if (!out || out.totalReviews === 0) {
        print("No reviews matched. Run data_generation/mongo_seeder.py first.");
    } else {
        print(`--- ${out.totalReviews.toLocaleString()} reviews aggregated in ${ms} ms`);
        print("");

        print(`  OVERALL   average ${out.avgRating}   sd ${out.stdDev}   ` +
              `range ${out.minRating}-${out.maxRating}`);
        print("");

        print("  RATING DISTRIBUTION");
        const maxCount = Math.max(...out.ratingDistribution.map((r) => r.count));
        for (const r of out.ratingDistribution) {
            const pct = (100 * r.count / out.totalReviews).toFixed(1);
            const bar = "#".repeat(Math.max(1, Math.round(34 * r.count / maxCount)));
            print(`    ${r.rating} star  ${String(r.count).padStart(7)}  ` +
                  `${String(pct).padStart(5)}%  ${bar}`);
        }
        print("");

        print("  TOP 10 TAGS  (via $unwind)");
        for (const t of out.topTags) {
            print(`    ${t.tag.padEnd(20)} ${String(t.count).padStart(7)}`);
        }
        print("");

        print("  SENTIMENT");
        for (const s of out.sentimentSplit) {
            print(`    ${s.sentiment.padEnd(20)} ${String(s.count).padStart(7)}`);
        }
        print("");

        print("  MONTHLY TREND  (last 6 months with reviews)");
        for (const m of out.monthlyTrend) {
            print(`    ${m.month}   avg ${m.avgRating}   n=${m.count}`);
        }
    }


    const exec = execStatsOf(db.Reviews.explain("executionStats").aggregate(pipeline, options));
    print("");
    if (exec) {
        const stages = stageNames(exec.executionStages);
        const total = db.Reviews.estimatedDocumentCount();
        print(`  collection size    : ${total.toLocaleString()} reviews`);
        print(`  documents examined : ${exec.totalDocsExamined.toLocaleString()}`);
        print(`  keys examined      : ${exec.totalKeysExamined.toLocaleString()}`);
        print(`  execution time     : ${exec.executionTimeMillis} ms`);
        print(`  plan stages        : ${stages.join(" <- ")}`);

        if (stages.includes("COLLSCAN")) {
            if (SCOPE_ALL) {
                print("  verdict            : COLLSCAN - EXPECTED for SCOPE=\"all\". The " +
                      "predicate covers most of");
                print("                       the collection, so a full scan genuinely IS " +
                      "the cheaper plan.");
            } else {
                throw new Error("FAIL: COLLSCAN on a single-restaurant query - the index is not being used");
            }
        } else if (stages.includes("IXSCAN")) {
            print("  verdict            : IXSCAN on ix_reviews_restaurant_recent, no COLLSCAN -> index confirmed");
        }
    }
}

print("");
print("--- Workflow 4 complete");
