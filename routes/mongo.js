import { Router } from "express";
import { getMongoDb } from "../db/mongo.js";

const router = Router();

router.get("/nearby", async (req, res, next) => {
  try {
    const restaurantId = Number(req.query.restaurant_id);
    const radius = Math.min(5000, Math.max(100, Number(req.query.radius || 5000)));
    const limit = Math.min(20, Math.max(1, Number(req.query.limit || 20)));
    if (!Number.isInteger(restaurantId)) return res.status(400).json({ error: "Invalid restaurant id." });

    const db = await getMongoDb();
    const menu = await db.collection("Menus").findOne(
      { restaurant_id: restaurantId }, { projection: { restaurant_id:1,name:1,city:1,location:1 } }
    );
    if (!menu) return res.status(404).json({ error: "No Mongo menu/origin found for this restaurant." });

    const pipeline = [
      { $geoNear: {
        near: menu.location, distanceField: "distance_m", maxDistance: radius,
        spherical: true, key: "location", query: { status: "ACTIVE" }
      }},
      { $sort: { driver_id: 1, distance_m: 1 } },
      { $group: {
        _id: "$driver_id",
        distance_m: { $first: "$distance_m" },
        location: { $first: "$location" },
        seen_at: { $first: "$created_at" },
        speed_kmph: { $first: "$speed_kmph" },
        order_id: { $first: "$order_id" },
        ping_count: { $sum: 1 }
      }},
      { $sort: { distance_m: 1 } },
      { $limit: limit },
      { $project: {
        _id:0, driver_id:"$_id",
        distance_m:{$round:["$distance_m",1]},
        eta_minutes:{$round:[{$divide:["$distance_m",366.7]},1]},
        speed_kmph:1,busy_with_order:"$order_id",pings_in_radius:"$ping_count",seen_at:1,location:1
      }}
    ];
    const data = await db.collection("DriverPings").aggregate(pipeline).toArray();
    res.json({
      origin: { restaurant_id: menu.restaurant_id, name: menu.name, city: menu.city,
                latitude: menu.location.coordinates[1], longitude: menu.location.coordinates[0] },
      radius, data
    });
  } catch (e) { next(e); }
});

router.get("/reviews", async (req, res, next) => {
  try {
    const restaurantId = req.query.restaurant_id ? Number(req.query.restaurant_id) : null;
    const since = new Date(Date.now() - 540 * 24 * 3600 * 1000);
    const match = restaurantId ? { restaurant_id: restaurantId, created_at: { $gte: since } }
                               : { created_at: { $gte: since } };
    const db = await getMongoDb();
    const pipeline = [
      { $match: match },
      { $facet: {
        ratingDistribution: [
          { $group: { _id:"$rating", count:{$sum:1} } },
          { $sort: {_id:1} },
          { $project: {_id:0,rating:"$_id",count:1} }
        ],
        topTags: [
          { $unwind:"$tags" },
          { $group:{_id:"$tags",count:{$sum:1}} },
          { $sort:{count:-1,_id:1} },
          { $limit:10 },
          { $project:{_id:0,tag:"$_id",count:1} }
        ],
        overall: [
          { $group:{_id:null,avgRating:{$avg:"$rating"},totalReviews:{$sum:1},
                    stdDev:{$stdDevPop:"$rating"},minRating:{$min:"$rating"},maxRating:{$max:"$rating"}} }
        ],
        sentimentSplit: [
          { $group:{_id:"$sentiment",count:{$sum:1}} },
          { $sort:{count:-1} },
          { $project:{_id:0,sentiment:"$_id",count:1} }
        ],
        monthlyTrend: [
          { $group:{_id:{$dateToString:{format:"%Y-%m",date:"$created_at"}},
                    avgRating:{$avg:"$rating"},count:{$sum:1}} },
          { $sort:{_id:-1} }, { $limit:6 },
          { $project:{_id:0,month:"$_id",avgRating:{$round:["$avgRating",2]},count:1} }
        ]
      }},
      { $project: {
        ratingDistribution:1,topTags:1,sentimentSplit:1,monthlyTrend:1,
        totalReviews:{$ifNull:[{$arrayElemAt:["$overall.totalReviews",0]},0]},
        avgRating:{$round:[{$ifNull:[{$arrayElemAt:["$overall.avgRating",0]},0]},3]},
        stdDev:{$round:[{$ifNull:[{$arrayElemAt:["$overall.stdDev",0]},0]},3]},
        minRating:{$arrayElemAt:["$overall.minRating",0]},
        maxRating:{$arrayElemAt:["$overall.maxRating",0]}
      }}
    ];
    const data = (await db.collection("Reviews").aggregate(pipeline, { allowDiskUse:true }).toArray())[0] || {
      ratingDistribution:[],topTags:[],sentimentSplit:[],monthlyTrend:[],totalReviews:0,avgRating:0
    };
    res.json({ restaurant_id: restaurantId, ...data });
  } catch (e) { next(e); }
});

router.get("/menus/:restaurantId", async (req, res, next) => {
  try {
    const db = await getMongoDb();
    const doc = await db.collection("Menus").findOne(
      { restaurant_id:Number(req.params.restaurantId) },
      { projection:{_id:0} }
    );
    if (!doc) return res.status(404).json({ error:"Menu not found." });
    res.json(doc);
  } catch (e) { next(e); }
});

export default router;
