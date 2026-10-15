# Handover Note – BiteStream (Project 1)

**Course:** CS6.302 Software System Development – Assignment 2 (Front End Design)  
**Inherited from:** Assignment 1 Team [team 5] – [[repository link](https://github.com/adimitt/team5_a1)]  
**Our team:** Assignment 1B Team [team 2] - [[repository link](https://github.com/vivekbhatt816/team2_a1b)]  

## What we inherited

We inherited the Assignment 1 BiteStream backend, consisting of PostgreSQL and MongoDB databases, SQL/MongoDB workflow scripts, and data-generation scripts. The four workflows are:

| # | Workflow | Main implementation |
|---|---|---|
| 1 | Place an order: wallet debit, order creation, wallet audit trigger, and prevention of a second active order | PostgreSQL stored procedure, trigger, and partial unique index (`sql/`) |
| 2 | Revenue analytics: seven-day moving average and restaurant ranking, with materialized-view summaries | PostgreSQL window queries and materialized view (`sql/`) |
| 3 | Find nearby active drivers for a restaurant | MongoDB `$geoNear` aggregation and geospatial index (`mongo/`) |
| 4 | Review analytics and menu data | MongoDB `$facet` aggregation and `Menus` collection (`mongo/`) |

## What worked

- We were able to start the inherited system locally and load the database data and workflow components using the repository setup instructions, with local environment configuration.
- The frontend/API launched locally, and the main screens were available: Overview, Browse, Checkout, Wallet Audit, Analytics, Live Driver Map, and Reviews.
- The checkout flow was exercised successfully through the UI.
- The PostgreSQL window-analytics script completed all three queries.
- The materialized-view refresh procedure completed successfully and reported 1,000 rows in the local test environment.
- The MongoDB nearby-driver workflow returned a nearby active driver for a restaurant. Its explain output showed the geospatial index (`ix_pings_geo`) and `GEO_NEAR_2DSPHERE`, with no `COLLSCAN` in the winning geospatial plan.
- The MongoDB review workflow returned review statistics. Its explain output used `ix_reviews_restaurant_recent` for the restaurant-scoped query, with no `COLLSCAN` in the winning cursor plan.

These checks confirm that the listed workflows executed in our local test environment; they do not establish that every error path or concurrency edge case has been tested.

## What did not work / limitations observed

- The DriverPings collection uses a 2-hour TTL (7,200 seconds), as required by the Assignment 1 specification. Older pings expire automatically, so the available ping count may decrease over time. This is expected behaviour, not a defect.
