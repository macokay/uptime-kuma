const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const express = require("express");

const routerPath = path.join(__dirname, "../../server/routers/maintenance-router.js");

const state = {
    maintenanceList: {},
    stored: [],
    execs: [],
    sent: [],
    getCellResult: 1,
};

const fakeServer = {
    maintenanceList: state.maintenanceList,
    getMaintenance(id) {
        return this.maintenanceList[id] || null;
    },
    async getMaintenanceJSONList() {
        const out = {};
        for (const id in this.maintenanceList) {
            out[id] = { id: Number(id), title: this.maintenanceList[id].title };
        }
        return out;
    },
    async sendMaintenanceListByUserID(userID) {
        state.sent.push(userID);
    },
};

const fakeRedbean = {
    async getCell() {
        return state.getCellResult;
    },
    async exec(sql, params) {
        state.execs.push({ sql, params });
    },
    async store(bean) {
        state.stored.push(bean);
        if (!bean.id) {
            bean.id = state.stored.length;
        }
        return bean.id;
    },
    dispense(type) {
        const bean = {
            __type: type,
            import(obj) {
                Object.assign(this, obj);
            },
        };
        return bean;
    },
};

/**
 * Build a fake maintenance bean for the running-server map.
 * @param {number} id Maintenance id
 * @param {string} title Maintenance title
 * @returns {object} Fake bean
 */
function makeFakeMaintenance(id, title) {
    return {
        id,
        title,
        user_id: 1,
        active: false,
        stopped: false,
        ran: false,
        stop() {
            this.stopped = true;
        },
        async run() {
            this.ran = true;
        },
    };
}

const fakeMaintenanceModel = {
    async jsonToBean(bean, obj) {
        Object.assign(bean, {
            title: obj.title,
            strategy: obj.strategy,
            active: obj.active,
            start_date: obj.dateRange[0],
            end_date: obj.dateRange[1],
        });
        bean.run = async function () {
            this.ran = true;
        };
        bean.stop = function () {
            this.stopped = true;
        };
        return bean;
    },
};

/**
 * Replace heavy server modules in require.cache with fakes.
 * @returns {void}
 */
function installMocks() {
    const mocks = {
        redbean: { id: require.resolve("redbean-node"), exports: { R: fakeRedbean } },
        apicache: {
            id: require.resolve(path.join(__dirname, "../../server/modules/apicache")),
            exports: { clear() {} },
        },
        auth: {
            id: require.resolve(path.join(__dirname, "../../server/auth.js")),
            exports: {
                apiAuth(req, res, next) {
                    if (!req.headers.authorization) {
                        return res.status(401).json({ ok: false, msg: "unauthorized" });
                    }
                    next();
                },
            },
        },
        uptimeServer: {
            id: require.resolve(path.join(__dirname, "../../server/uptime-kuma-server.js")),
            exports: { UptimeKumaServer: { getInstance: () => fakeServer } },
        },
        maintenance: {
            id: require.resolve(path.join(__dirname, "../../server/model/maintenance.js")),
            exports: fakeMaintenanceModel,
        },
        util: {
            id: require.resolve(path.join(__dirname, "../../src/util.js")),
            exports: { log: { error() {}, info() {}, debug() {}, warn() {} } },
        },
    };
    for (const key in mocks) {
        const entry = mocks[key];
        require.cache[entry.id] = { id: entry.id, filename: entry.id, loaded: true, exports: entry.exports };
    }
}

let server;
let base;

before(async () => {
    installMocks();
    delete require.cache[routerPath];
    const router = require(routerPath);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
    for (const key in state.maintenanceList) {
        delete state.maintenanceList[key];
    }
    state.stored.length = 0;
    state.execs.length = 0;
    state.sent.length = 0;
    state.getCellResult = 1;
});

const AUTH = { authorization: "Basic dXNlcjpwYXNz" };

/**
 * Send an HTTP request to the test server.
 * @param {string} method HTTP method
 * @param {string} url Path
 * @param {object} body JSON body
 * @param {object} headers Request headers
 * @returns {Promise<{status: number, body: object}>} Response
 */
async function call(method, url, body, headers = AUTH) {
    const res = await fetch(base + url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

describe("maintenance REST auth", () => {
    test("rejects request without credentials", async () => {
        const res = await call("GET", "/api/maintenance", undefined, {});
        assert.strictEqual(res.status, 401);
    });
});

describe("POST /api/maintenance", () => {
    test("creates manual window, links monitors, sends list", async () => {
        const res = await call("POST", "/api/maintenance", {
            title: "ZimaCube night off",
            monitorIds: [4, 7],
            statusPageIds: [],
        });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.ok, true);
        assert.ok(res.body.maintenanceID);
        const monitorLinks = state.execs.filter((e) => e.sql.startsWith("DELETE FROM monitor_maintenance"));
        assert.strictEqual(monitorLinks.length, 1);
        const linked = state.stored.filter((b) => b.__type === "monitor_maintenance").map((b) => b.monitor_id);
        assert.deepStrictEqual(linked, [4, 7]);
        assert.deepStrictEqual(state.sent, [1]);
    });

    test("rejects missing title", async () => {
        const res = await call("POST", "/api/maintenance", { monitorIds: [1] });
        assert.strictEqual(res.status, 400);
    });

    test("rejects unknown strategy", async () => {
        const res = await call("POST", "/api/maintenance", { title: "x", strategy: "cron" });
        assert.strictEqual(res.status, 400);
    });

    test("single strategy needs end after start", async () => {
        const res = await call("POST", "/api/maintenance", {
            title: "x",
            strategy: "single",
            start: "2026-10-17T10:00:00Z",
            end: "2026-10-17T09:00:00Z",
        });
        assert.strictEqual(res.status, 400);
    });

    test("rejects non-integer monitor ids", async () => {
        const res = await call("POST", "/api/maintenance", { title: "x", monitorIds: ["4; DROP"] });
        assert.strictEqual(res.status, 400);
    });
});

describe("resume / pause / delete", () => {
    test("resume unknown id returns 404", async () => {
        const res = await call("POST", "/api/maintenance/999/resume");
        assert.strictEqual(res.status, 404);
    });

    test("resume sets active and runs", async () => {
        const m = makeFakeMaintenance(3, "w");
        state.maintenanceList[3] = m;
        const res = await call("POST", "/api/maintenance/3/resume");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(m.active, true);
        assert.strictEqual(m.ran, true);
    });

    test("pause sets inactive and stops", async () => {
        const m = makeFakeMaintenance(3, "w");
        m.active = true;
        state.maintenanceList[3] = m;
        const res = await call("POST", "/api/maintenance/3/pause");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(m.active, false);
        assert.strictEqual(m.stopped, true);
    });

    test("delete removes from list and DB", async () => {
        const m = makeFakeMaintenance(3, "w");
        state.maintenanceList[3] = m;
        const res = await call("DELETE", "/api/maintenance/3");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(m.stopped, true);
        assert.strictEqual(state.maintenanceList[3], undefined);
        assert.ok(state.execs.some((e) => e.sql === "DELETE FROM maintenance WHERE id = ?"));
    });

    test("delete unknown id returns 404", async () => {
        const res = await call("DELETE", "/api/maintenance/42");
        assert.strictEqual(res.status, 404);
    });
});

describe("GET /api/maintenance", () => {
    test("lists maintenance windows", async () => {
        state.maintenanceList[1] = makeFakeMaintenance(1, "a");
        const res = await call("GET", "/api/maintenance");
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.maintenance.length, 1);
        assert.strictEqual(res.body.maintenance[0].title, "a");
    });
});
