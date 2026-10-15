const state = {
  page: "dashboard",
  actor: null,
  actors: [],
  charts: {},
  map: null,
  markers: [],
  mapTimer: null,
};

const $ = (s) => document.querySelector(s);
const main = $("#main");

async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = {};

  try {
    data = await r.json();
  } catch {}

  if (!r.ok) throw new Error(data.error || "Request failed");

  return data;
}

function money(v) {
  return `₹${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function date(v) {
  return v
    ? new Date(v).toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

function errBox(msg) {
  return `<div class="alert error">${esc(msg)}</div>`;
}

function badge(s) {
  const c =
    s === "DELIVERED"
      ? "green"
      : s === "PREPARING"
        ? "orange"
        : s === "DELIVERING"
          ? "orange"
          : "gray";
  return `<span class="badge ${c}">${esc(s)}</span>`;
}

function layout(title, subtitle, body, actions = "") {
  return `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>${body}`;
}

async function loadActors() {
  try {
    const d = await api("/api/users?limit=10");
    state.actors = d.data;

    $("#actorSelect").innerHTML = state.actors
      .map(
        (u) =>
          `<option value="${u.id}">${esc(u.name)} · #${u.id} · ${money(u.wallet_balance)}</option>`,
      )
      .join("");

    const saved = localStorage.getItem("bs_actor");
    state.actor =
      state.actors.find((u) => String(u.id) === saved) ||
      state.actors[0] ||
      null;

    if (state.actor) $("#actorSelect").value = state.actor.id;
  } catch (e) {
    $("#actorSelect").innerHTML = "<option>API unavailable</option>";
  }
}

$("#actorSelect").addEventListener("change", () => {
  state.actor = state.actors.find(
    (u) => String(u.id) === $("#actorSelect").value,
  );
  if (state.actor) localStorage.setItem("bs_actor", state.actor.id);
  toast("Actor switched");
  if (state.page === "transaction" || state.page === "audit") render();
});

document
  .querySelectorAll("#nav button")
  .forEach((b) => b.addEventListener("click", () => navigate(b.dataset.page)));

function navigate(page) {
  state.page = page;
  document
    .querySelectorAll("#nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  render();
}

async function render() {
  if (state.mapTimer) {
    clearInterval(state.mapTimer);
    state.mapTimer = null;
  }
  if (state.map) {
    state.map.remove();
    state.map = null;
  }

  main.innerHTML = '<div class="loading">Loading…</div>';

  const fn = {
    dashboard: renderDashboard,
    browse: renderBrowse,
    transaction: renderTransaction,
    audit: renderAudit,
    analytics: renderAnalytics,
    map: renderMap,
    reviews: renderReviews,
  }[state.page];

  try {
    await fn();
  } catch (e) {
    main.innerHTML = errBox(e.message);
  }
}

async function renderDashboard() {
  const [users, restaurants, orders, summary] = await Promise.all([
    api("/api/users?limit=1"),
    api("/api/restaurants?limit=1"),
    api("/api/orders?limit=1"),
    api("/api/analytics/summary"),
  ]);

  const totalRevenue = summary.data.reduce(
    (a, x) => a + Number(x.total_revenue || 0),
    0,
  );

  main.innerHTML = layout(
    "Operations overview",
    "A compact view of the BiteStream PostgreSQL + MongoDB workflows.",
    `<div class="grid grid-4">
      <div class="card metric"><div class="label">USERS</div><div class="value">${users.total.toLocaleString()}</div><div class="hint">PostgreSQL customers</div></div>
      <div class="card metric"><div class="label">RESTAURANTS</div><div class="value">${restaurants.total.toLocaleString()}</div><div class="hint">Browseable vendors</div></div>
      <div class="card metric"><div class="label">ORDERS</div><div class="value">${orders.total.toLocaleString()}</div><div class="hint">Transaction history</div></div>
      <div class="card metric"><div class="label">TOP-20 REVENUE</div><div class="value">${money(totalRevenue)}</div><div class="hint">Materialized-view snapshot</div></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h3>Workflow coverage</h3><div class="kpis">
        <div class="kpi">01 · Atomic checkout</div><div class="kpi">02 · Window analytics</div>
        <div class="kpi">03 · $geoNear live drivers</div><div class="kpi">04 · $facet review analytics</div>
      </div><p style="color:var(--muted);font-size:12px;line-height:1.6">The browser calls a small Express API. Database procedures, triggers, window functions, materialized views and MongoDB aggregation pipelines remain the source of business logic.</p></div>
      <div class="card"><h3>Quick actions</h3><div class="actions">
        <button class="btn primary" onclick="navigate('transaction')">Make a checkout</button>
        <button class="btn" onclick="navigate('analytics')">Open analytics</button>
        <button class="btn" onclick="navigate('map')">Open live map</button>
        <button class="btn" onclick="navigate('reviews')">Review insights</button>
      </div><p style="color:var(--muted);font-size:11px;margin-top:14px">Current actor: <b>${esc(state.actor?.name || "not selected")}</b>. Real login is intentionally not required by the brief.</p></div>
    </div>`,
  );
}

async function renderBrowse() {
  main.innerHTML = layout(
    "Browse",
    "Paginated/searchable views for users, restaurants and orders.",
    `<div class="card"><div class="toolbar">
      <select id="browseType"><option value="restaurants">Restaurants</option><option value="users">Users</option><option value="orders">Orders</option></select>
      <input id="browseQ" placeholder="Search name, city, email or order…">
      <select id="browseStatus"><option value="">All statuses</option><option>PREPARING</option><option>DELIVERING</option><option>DELIVERED</option></select>
      <button class="btn primary" id="browseGo">Search</button>
    </div><div id="browseTable"></div></div>`,
  );

  $("#browseGo").onclick = () => loadBrowse(1);
  $("#browseType").onchange = () => {
    $("#browseStatus").style.display =
      $("#browseType").value === "orders" ? "block" : "none";
    loadBrowse(1);
  };
  $("#browseStatus").style.display = "none";

  await loadBrowse(1);
}

async function loadBrowse(page) {
  const type = $("#browseType").value,
    q = encodeURIComponent($("#browseQ").value || ""),
    st = encodeURIComponent($("#browseStatus").value || "");
  const d = await api(`/api/${type}?page=${page}&limit=20&q=${q}&status=${st}`);

  let rows = "",
    heads = "";

  if (type === "restaurants") {
    heads =
      "<th>ID</th><th>Restaurant</th><th>City</th><th>Status</th><th>Coordinates</th><th></th>";
    rows = d.data
      .map(
        (x) =>
          `<tr><td>#${x.id}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.city)}</td><td>${x.is_active ? '<span class="badge green">ACTIVE</span>' : '<span class="badge gray">INACTIVE</span>'}</td><td>${Number(x.latitude).toFixed(4)}, ${Number(x.longitude).toFixed(4)}</td><td><button class="btn" onclick="showRestaurant(${x.id})">Details</button></td></tr>`,
      )
      .join("");
  } else if (type === "users") {
    heads =
      "<th>ID</th><th>Name</th><th>Email</th><th>Wallet</th><th>Created</th>";
    rows = d.data
      .map(
        (x) =>
          `<tr><td>#${x.id}</td><td><b>${esc(x.name)}</b></td><td>${esc(x.email || "—")}</td><td>${money(x.wallet_balance)}</td><td>${date(x.created_at)}</td></tr>`,
      )
      .join("");
  } else {
    heads =
      "<th>Order</th><th>Customer</th><th>Restaurant</th><th>Amount</th><th>Status</th><th>Created</th><th></th>";
    rows = d.data
      .map(
        (x) =>
          `<tr><td>#${x.id}</td><td>${esc(x.user_name)} · #${x.user_id}</td><td>${esc(x.restaurant_name)}</td><td>${money(x.total_amount)}</td><td>${badge(x.status)}</td><td>${date(x.created_at)}</td><td><button class="btn" onclick="showOrder(${x.id})">Details</button></td></tr>`,
      )
      .join("");
  }

  $("#browseTable").innerHTML = rows
    ? `<div class="table-wrap"><table class="table"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>
  <div class="pagination"><span>Showing page ${d.page} · ${d.total.toLocaleString()} total</span><div class="right"><button class="btn" ${d.page <= 1 ? "disabled" : ""} onclick="loadBrowse(${d.page - 1})">Previous</button><button class="btn" ${d.page * d.limit >= d.total ? "disabled" : ""} onclick="loadBrowse(${d.page + 1})">Next</button></div></div>`
    : "<div class='empty'>No records match your search.</div>";
}

window.showRestaurant = async (id) => {
  const [r, m] = await Promise.all([
    api(`/api/restaurants/${id}`),
    api(`/api/mongo/menus/${id}`),
  ]);

  $("#browseTable").innerHTML =
    `<div class="alert info"><b>${esc(r.name)}</b> · ${esc(r.city)} · ${r.is_active ? "Active" : "Inactive"}<br>Origin for MongoDB $geoNear: ${r.latitude}, ${r.longitude}</div>
  <div class="card" style="box-shadow:none"><h3>Flexible menu document</h3><div class="catalog">${m.categories.map((c) => `<div class="cat"><h4>${esc(c.name)}</h4>${c.items.map((i) => `<div class="item"><b>${esc(i.name)}</b><span>${money(i.price)} · ${i.veg ? "Veg" : "Non-veg"}</span></div>`).join("")}</div>`).join("")}</div></div>`;
};

window.showOrder = async (id) => {
  const o = await api(`/api/orders/${id}`);

  $("#browseTable").innerHTML =
    `<div class="card" style="box-shadow:none"><h3>Order #${o.id}</h3><div class="grid grid-3">
    <div><small>Customer</small><p>${esc(o.user_name)} · #${o.user_id}</p></div><div><small>Restaurant</small><p>${esc(o.restaurant_name)} · ${esc(o.city)}</p></div><div><small>Status</small><p>${badge(o.status)}</p></div>
    <div><small>Amount</small><p>${money(o.total_amount)}</p></div><div><small>Created</small><p>${date(o.created_at)}</p></div><div><small>Delivered</small><p>${date(o.delivered_at)}</p></div>
  </div><button class="btn primary" ${o.status === "DELIVERED" ? "disabled" : ""} onclick="advanceOrder(${o.id})">Advance status</button></div>`;
};

window.advanceOrder = async (id) => {
  try {
    await api(`/api/orders/${id}/advance`, { method: "POST" });
    toast("Order status advanced");
    showOrder(id);
  } catch (e) {
    toast(e.message);
  }
};

async function renderTransaction() {
  const [restaurants, actor] = await Promise.all([
    api("/api/restaurants?limit=50&active=true"),
    api(`/api/users/${state.actor.id}`),
  ]);

  main.innerHTML = layout(
    "Checkout",
    "Workflow 1 · the stored procedure performs the atomic wallet debit + order insert.",
    `<div class="grid grid-2"><div class="card"><h3>New checkout</h3>
      <form id="checkoutForm"><div class="form-grid">
        <div class="field"><label>Actor / customer</label><input value="${esc(actor.name)} · #${actor.id}" disabled></div>
        <div class="field"><label>Restaurant</label><select id="txRestaurant">${restaurants.data.map((r) => `<option value="${r.id}">${esc(r.name)} · ${esc(r.city)} (#${r.id})</option>`).join("")}</select></div>
        <div class="field"><label>Amount (INR)</label><input id="txAmount" type="number" min="0.01" step="0.01" placeholder="250.00" required></div>
      </div><button class="btn primary" style="margin-top:15px">Execute checkout</button></form>
      <div id="txResult" style="margin-top:15px"></div>
    </div>
    <div class="card"><h3>Actor wallet</h3><div class="balance-row">
      <div class="balance"><small>Before checkout</small><b id="txBefore">${money(actor.wallet_balance)}</b></div>
      <div class="balance"><small>Current balance</small><b id="txAfter">${money(actor.wallet_balance)}</b></div>
    </div><p style="color:var(--muted);font-size:11px;line-height:1.5;margin-top:15px">Failure cases are reported from the procedure: insufficient funds, active order, bad reference, invalid amount and retry. A failed call is rolled back, so no partial debit/order/audit remains.</p></div></div>`,
  );

  $("#checkoutForm").onsubmit = async (e) => {
    e.preventDefault();
    $("#txResult").innerHTML = '<div class="alert info">Processing…</div>';

    try {
      const d = await api("/api/checkout", {
        method: "POST",
        body: JSON.stringify({
          user_id: state.actor.id,
          restaurant_id: Number($("#txRestaurant").value),
          amount: Number($("#txAmount").value),
        }),
      });

      $("#txBefore").textContent = money(d.balance_before);
      $("#txAfter").textContent = money(d.balance_after);

      $("#txResult").innerHTML =
        `<div class="alert ${d.ok ? "success" : "error"}"><b>${esc(d.status)}</b> · ${esc(d.message)}${d.order_id ? `<br>New order: #${d.order_id}` : ""}${d.audit ? `<br>Audit #${d.audit.id}: ${esc(d.audit.action_type)} ${money(d.audit.amount_changed)} · balance ${money(d.audit.balance_after)}` : ""}</div>`;

      if (d.ok) state.actor.wallet_balance = d.balance_after;
    } catch (e) {
      $("#txResult").innerHTML = errBox(e.message);
    }
  };
}

async function renderAudit() {
  main.innerHTML = layout(
    "Wallet audit trail",
    "Read-only trigger-generated ledger for the selected actor.",
    `<div class="card"><div class="toolbar"><input id="auditFrom" type="date"><input id="auditTo" type="date"><button class="btn primary" id="auditGo">Apply dates</button></div><div id="auditTable" class="loading">Loading…</div></div>`,
  );

  $("#auditGo").onclick = loadAudit;
  await loadAudit();
}

async function loadAudit() {
  const q = new URLSearchParams();

  if ($("#auditFrom").value) q.set("from", $("#auditFrom").value);
  if ($("#auditTo").value) q.set("to", $("#auditTo").value);

  const d = await api(`/api/users/${state.actor.id}/audit?${q}`);

  let running = 0;

  const rows = d.data
    .map((x) => {
      running = Number(x.balance_after);
      return `<tr><td>#${x.id}</td><td>${date(x.timestamp)}</td><td>${esc(x.action_type)}</td><td>${money(x.amount_changed)}</td><td>${money(x.balance_after)}</td><td>${money(running)}</td></tr>`;
    })
    .join("");

  $("#auditTable").innerHTML = rows
    ? `<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Time</th><th>Action</th><th>Change</th><th>Balance after</th><th>Running balance</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : "<div class='empty'>No audit entries for this actor/date range.</div>";
}

// async function renderAnalytics(){
//   const [rev,rank,sum]=await Promise.all([api("/api/analytics/revenue"),api("/api/analytics/rankings"),api("/api/analytics/summary")]);

//   main.innerHTML=layout("Analytics","Workflow 2 · PostgreSQL window functions + materialized-view leaderboard.",
//     `<div class="grid grid-2"><div class="card chart-card"><h3>7-day moving average revenue · top 5 vendors</h3><div class="chart-box"><canvas id="revChart"></canvas></div></div>
//     <div class="card"><h3>DENSE_RANK · latest complete day</h3><div class="table-wrap"><table class="table"><thead><tr><th>Rank</th><th>Restaurant</th><th>7-day avg</th><th>Orders 7d</th></tr></thead><tbody>${rank.data.map(x=>`<tr><td><b>#${x.rank_by_ma7}</b></td><td>${esc(x.restaurant)}</td><td>${money(x.ma7_revenue)}</td><td>${x.orders_last_7d}</td></tr>`).join("")}</tbody></table></div></div></div>
//     <div class="card" style="margin-top:16px"><div class="page-head" style="margin-bottom:12px"><div><h3 style="margin:0">Materialized-view restaurant performance</h3><p>Last-order timestamp is the available snapshot freshness indicator.</p></div><button class="btn primary" id="refreshMV">Refresh snapshot</button></div>
//       <div id="mvMsg"></div><div class="table-wrap"><table class="table"><thead><tr><th>Restaurant</th><th>City</th><th>Delivered orders</th><th>Total revenue</th><th>Avg order</th><th>Last order</th></tr></thead><tbody>${sum.data.slice(0,12).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.city)}</td><td>${Number(x.completed_orders).toLocaleString()}</td><td>${money(x.total_revenue)}</td><td>${money(x.avg_order_value)}</td><td>${date(x.last_order_at)}</td></tr>`).join("")}</tbody></table></div>
//       <p style="font-size:10px;color:var(--muted);margin-bottom:0">Snapshot last-order timestamp: ${date(sum.last_order_at)}.</p></div>`);

//   const labels=[...new Set(rev.data.map(x=>x.business_date))].sort();
//   const names=[...new Set(rev.data.map(x=>x.restaurant))];

//   new Chart($("#revChart"),{type:"line",data:{labels,datasets:names.map(n=>({label:n,data:labels.map(d=>{const x=rev.data.find(y=>y.business_date===d&&y.restaurant===n);return x?Number(x.ma7_revenue):null}),tension:.25}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom"}},scales:{y:{beginAtZero:true}}}});

//   $("#refreshMV").onclick=async()=>{
//     try{
//       await api("/api/analytics/summary/refresh",{method:"POST"});
//       $("#mvMsg").innerHTML='<div class="alert success">Materialized view refreshed. Reloading snapshot…</div>';
//       setTimeout(renderAnalytics,600);
//     }catch(e){
//       $("#mvMsg").innerHTML=errBox(e.message);
//     }
//   };
// }

async function renderAnalytics() {
  const [restaurants, rank, sum] = await Promise.all([
    api("/api/restaurants?limit=50"),
    api("/api/analytics/rankings"),
    api("/api/analytics/summary"),
  ]);

  main.innerHTML = layout(
    "Analytics",
    "Workflow 2 · PostgreSQL window functions + materialized-view leaderboard.",
    `
    <div class="grid grid-2">

      <div class="card chart-card">
        <h3>7-day Moving Average Revenue</h3>

        <div class="toolbar">
          <label for="revenueRestaurant">Select restaurant:</label>

          <select id="revenueRestaurant">
            ${restaurants.data
              .map(
                (r) => `
              <option value="${r.id}">
                ${esc(r.name)} · ${esc(r.city)} (#${r.id})
              </option>
            `,
              )
              .join("")}
          </select>
        </div>

        <div id="revenueChartMsg"></div>

        <div class="chart-box">
          <canvas id="revChart"></canvas>
        </div>
      </div>

      <div class="card">
        <h3>DENSE_RANK · latest complete day</h3>

        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Restaurant</th>
                <th>7-day avg</th>
                <th>Orders 7d</th>
              </tr>
            </thead>

            <tbody>
              ${rank.data
                .map(
                  (x) => `
                <tr>
                  <td><b>#${x.rank_by_ma7}</b></td>
                  <td>${esc(x.restaurant)}</td>
                  <td>${money(x.ma7_revenue)}</td>
                  <td>${x.orders_last_7d}</td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>

    </div>

    <div class="card" style="margin-top:16px">

      <div class="page-head" style="margin-bottom:12px">
        <div>
          <h3 style="margin:0">
            Materialized-view restaurant performance
          </h3>
          <p>
            Last-order timestamp is the available snapshot freshness indicator.
          </p>
        </div>

        <button class="btn primary" id="refreshMV">
          Refresh snapshot
        </button>
      </div>

      <div id="mvMsg"></div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Restaurant</th>
              <th>City</th>
              <th>Delivered orders</th>
              <th>Total revenue</th>
              <th>Avg order</th>
              <th>Last order</th>
            </tr>
          </thead>

          <tbody>
            ${sum.data
              .slice(0, 12)
              .map(
                (x) => `
              <tr>
                <td>${esc(x.name)}</td>
                <td>${esc(x.city)}</td>
                <td>${Number(x.completed_orders).toLocaleString()}</td>
                <td>${money(x.total_revenue)}</td>
                <td>${money(x.avg_order_value)}</td>
                <td>${date(x.last_order_at)}</td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>

      <p style="font-size:10px;color:var(--muted);margin-bottom:0">
        Snapshot last-order timestamp: ${date(sum.last_order_at)}.
      </p>

    </div>
    `,
  );

  // Load chart for the initially selected restaurant.
  $("#revenueRestaurant").onchange = loadRevenueChart;

  await loadRevenueChart();

  // Preserve the existing materialized-view refresh functionality.
  $("#refreshMV").onclick = async () => {
    try {
      await api("/api/analytics/summary/refresh", {
        method: "POST",
      });

      $("#mvMsg").innerHTML =
        '<div class="alert success">Materialized view refreshed. Reloading snapshot…</div>';

      setTimeout(renderAnalytics, 600);
    } catch (e) {
      $("#mvMsg").innerHTML = errBox(e.message);
    }
  };
}

async function renderMap() {
  const restaurants = await api("/api/restaurants?limit=50&active=true");

  main.innerHTML = layout(
    "Live driver map",
    "Workflow 3 · MongoDB $geoNear from the selected restaurant origin. The list polls for fresh pings.",
    `<div class="card"><div class="toolbar"><select id="mapRestaurant">${restaurants.data.map((r) => `<option value="${r.id}">${esc(r.name)} · ${esc(r.city)} (#${r.id})</option>`).join("")}</select><select id="mapRadius"><option value="5000">5 km radius</option><option value="3000">3 km radius</option><option value="1000">1 km radius</option></select><button class="btn primary" id="mapGo">Find drivers</button><span style="font-size:10px;color:var(--muted);padding:9px">Auto-refresh every 10 seconds</span></div></div>
    <div class="map-layout" style="margin-top:16px"><div class="card" style="padding:10px"><div id="map"></div></div><div class="card"><h3>Nearest active drivers</h3><div id="nearList" class="near-list"></div></div></div>`,
  );

  $("#mapGo").onclick = loadMapData;
  await loadMapData();

  state.mapTimer = setInterval(loadMapData, 10000);
}

async function loadRevenueChart() {
  const restaurantId = $("#revenueRestaurant").value;
  const message = $("#revenueChartMsg");

  try {
    message.innerHTML = '<div class="loading">Loading revenue data...</div>';

    const result = await api(
      `/api/analytics/revenue?restaurant_id=${restaurantId}`,
    );

    const rows = result.data;

    // Destroy the previous chart before drawing a new one.
    if (state.charts.revenue) {
      state.charts.revenue.destroy();
      state.charts.revenue = null;
    }

    message.innerHTML = "";

    if (rows.length === 0) {
      message.innerHTML =
        '<div class="empty">No revenue data available for this restaurant.</div>';
      return;
    }

    // Dates returned by PostgreSQL are sorted by the backend.
    const labels = rows.map((x) => String(x.business_date).slice(0, 10));

    const movingAverage = rows.map((x) => Number(x.ma7_revenue));

    state.charts.revenue = new Chart($("#revChart"), {
      type: "line",

      data: {
        labels,

        datasets: [
          {
            label: "7-day moving average revenue",
            data: movingAverage,
            tension: 0.25,
            fill: false,
          },
        ],
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
          legend: {
            position: "bottom",
          },

          tooltip: {
            callbacks: {
              label: (context) => `Moving average: ${money(context.parsed.y)}`,
            },
          },
        },

        scales: {
          x: {
            title: {
              display: true,
              text: "Date",
            },
          },

          y: {
            beginAtZero: true,

            title: {
              display: true,
              text: "Revenue (₹)",
            },
          },
        },
      },
    });
  } catch (e) {
    message.innerHTML = errBox(e.message);
  }
}

async function loadMapData() {
  const id = $("#mapRestaurant").value,
    radius = $("#mapRadius").value,
    d = await api(
      `/api/mongo/nearby?restaurant_id=${id}&radius=${radius}&limit=20`,
    );

  if (!state.map) {
    state.map = L.map("map").setView(
      [d.origin.latitude, d.origin.longitude],
      14,
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(state.map);
  }

  state.markers.forEach((m) => m.remove());
  state.markers = [];

  const origin = L.marker([d.origin.latitude, d.origin.longitude])
    .addTo(state.map)
    .bindPopup(`<b>${esc(d.origin.name)}</b><br>Search origin`);
  state.markers.push(origin);

  d.data.forEach((x) => {
    if (x.location?.coordinates) {
      const m = L.circleMarker(
        [x.location.coordinates[1], x.location.coordinates[0]],
        {
          radius: 8,
          color: "#2563eb",
          fillColor: "#2563eb",
          fillOpacity: 1,
          weight: 2,
        },
      )
        .addTo(state.map)
        .bindPopup(`Driver #${x.driver_id}<br>${x.distance_m} m`);

      state.markers.push(m);
    }
  });
  $("#nearList").innerHTML = d.data.length
    ? d.data
        .map(
          (x) =>
            `<div class="driver"><div class="driver-top"><strong>Driver #${x.driver_id}</strong><span class="badge green">${x.distance_m} m</span></div><small>ETA ${x.eta_minutes} min · ${x.speed_kmph} km/h · ${x.busy_with_order ? "Order #" + x.busy_with_order : "Idle"}</small><br><small>Last seen ${date(x.seen_at)} · ${x.pings_in_radius} pings in radius</small></div>`,
        )
        .join("")
    : `<div class="empty">No active driver found within ${Number(radius) / 1000} km. DriverPings is intentionally TTL-based; reseed before a demo if it has expired.</div>`;
}

async function renderReviews() {
  const restaurants = await api("/api/restaurants?limit=50");

  main.innerHTML = layout(
    "Review intelligence",
    "Workflow 4 · MongoDB $facet for rating distribution, tags, sentiment and monthly trend.",
    `<div class="card"><div class="toolbar"><select id="reviewRestaurant"><option value="">All restaurants</option>${restaurants.data.map((r) => `<option value="${r.id}">${esc(r.name)} · #${r.id}</option>`).join("")}</select><button class="btn primary" id="reviewGo">Analyze</button></div>
    <div id="reviewContent" class="loading">Loading…</div></div>`,
  );

  $("#reviewGo").onclick = loadReviews;
  await loadReviews();
}

async function loadReviews() {
  const id = $("#reviewRestaurant").value;
  const d = await api(`/api/mongo/reviews${id ? `?restaurant_id=${id}` : ""}`);

  $("#reviewContent").innerHTML = `<div class="grid grid-4">
    <div class="card metric" style="box-shadow:none"><div class="label">REVIEWS</div><div class="value">${Number(d.totalReviews).toLocaleString()}</div></div>
    <div class="card metric" style="box-shadow:none"><div class="label">AVERAGE</div><div class="value">★ ${Number(d.avgRating || 0).toFixed(2)}</div></div>
    <div class="card metric" style="box-shadow:none"><div class="label">STD DEV</div><div class="value">${Number(d.stdDev || 0).toFixed(2)}</div></div>
    <div class="card metric" style="box-shadow:none"><div class="label">RANGE</div><div class="value">${d.minRating ?? "—"}–${d.maxRating ?? "—"}</div></div>
  </div>
  <div class="grid grid-2" style="margin-top:16px"><div class="card chart-card"><h3>Rating distribution</h3><div class="chart-box"><canvas id="ratingChart"></canvas></div></div>
  <div class="card chart-card"><h3>Sentiment split</h3><div class="chart-box"><canvas id="sentChart"></canvas></div></div></div>
  <div class="grid grid-2" style="margin-top:16px"><div class="card"><h3>Top 10 tags</h3><div class="table-wrap"><table class="table"><thead><tr><th>Tag</th><th>Count</th></tr></thead><tbody>${d.topTags.map((x) => `<tr><td>${esc(x.tag)}</td><td>${x.count.toLocaleString()}</td></tr>`).join("")}</tbody></table></div></div>
  <div class="card"><h3>Monthly trend</h3><div class="table-wrap"><table class="table"><thead><tr><th>Month</th><th>Avg rating</th><th>Reviews</th></tr></thead><tbody>${d.monthlyTrend
    .slice()
    .reverse()
    .map(
      (x) =>
        `<tr><td>${x.month}</td><td>★ ${x.avgRating}</td><td>${x.count.toLocaleString()}</td></tr>`,
    )
    .join("")}</tbody></table></div></div></div>`;

  new Chart($("#ratingChart"), {
    type: "bar",
    data: {
      labels: d.ratingDistribution.map((x) => `${x.rating}★`),
      datasets: [
        { label: "Reviews", data: d.ratingDistribution.map((x) => x.count) },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
    },
  });

  new Chart($("#sentChart"), {
    type: "doughnut",
    data: {
      labels: d.sentimentSplit.map((x) => x.sentiment),
      datasets: [{ data: d.sentimentSplit.map((x) => x.count) }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

(async () => {
  await loadActors();
  navigate("dashboard");
})();
