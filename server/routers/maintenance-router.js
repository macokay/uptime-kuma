let express = require("express");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const { apiAuth } = require("../auth");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const Maintenance = require("../model/maintenance");
const { log } = require("../../src/util");

let router = express.Router();

const server = UptimeKumaServer.getInstance();

const ALLOWED_STRATEGIES = ["manual", "single"];
const MAX_MONITORS_PER_REQUEST = 200;

/**
 * Resolve the owner of API-created maintenance windows. Kuma runs single-user in practice.
 * @returns {Promise<number|null>} First active user id
 */
async function getOwnerUserID() {
    return await R.getCell("SELECT id FROM user WHERE active = 1 ORDER BY id");
}

/**
 * Replace monitor and status page links for a maintenance window.
 * @param {number} maintenanceID Maintenance id
 * @param {number[]} monitorIDs Monitor ids
 * @param {number[]} statusPageIDs Status page ids
 * @returns {Promise<void>}
 */
async function replaceLinks(maintenanceID, monitorIDs, statusPageIDs) {
    await R.exec("DELETE FROM monitor_maintenance WHERE maintenance_id = ?", [maintenanceID]);
    for (const monitorID of monitorIDs) {
        let bean = R.dispense("monitor_maintenance");
        bean.import({ monitor_id: monitorID, maintenance_id: maintenanceID });
        await R.store(bean);
    }

    await R.exec("DELETE FROM maintenance_status_page WHERE maintenance_id = ?", [maintenanceID]);
    for (const statusPageID of statusPageIDs) {
        let bean = R.dispense("maintenance_status_page");
        bean.import({ status_page_id: statusPageID, maintenance_id: maintenanceID });
        await R.store(bean);
    }
}

/**
 * Validate an array of positive integer ids.
 * @param {any} value Input value
 * @returns {boolean} Valid?
 */
function isIdList(value) {
    return (
        Array.isArray(value) &&
        value.length <= MAX_MONITORS_PER_REQUEST &&
        value.every((id) => Number.isInteger(id) && id > 0)
    );
}

/**
 * Parse an ISO date string, or null when missing or invalid.
 * @param {any} value Input value
 * @returns {string|null} Date string or null
 */
function parseDate(value) {
    if (typeof value !== "string") {
        return null;
    }
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : value;
}

router.use("/api/maintenance", apiAuth);

router.get("/api/maintenance", async (_request, response) => {
    try {
        const list = await server.getMaintenanceJSONList();
        response.json({ ok: true, maintenance: Object.values(list) });
    } catch (e) {
        log.error("maintenance-api", e);
        response.status(500).json({ ok: false, msg: "Internal error" });
    }
});

router.post("/api/maintenance", async (request, response) => {
    try {
        const body = request.body || {};
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const strategy = body.strategy || "manual";
        const monitorIDs = body.monitorIds ?? [];
        const statusPageIDs = body.statusPageIds ?? [];

        if (title === "" || title.length > 150) {
            return response.status(400).json({ ok: false, msg: "title required, max 150 chars" });
        }
        if (!ALLOWED_STRATEGIES.includes(strategy)) {
            return response.status(400).json({ ok: false, msg: "strategy must be manual or single" });
        }
        if (!isIdList(monitorIDs) || !isIdList(statusPageIDs)) {
            return response.status(400).json({ ok: false, msg: "monitorIds/statusPageIds must be id arrays" });
        }

        let startDate = null;
        let endDate = null;
        if (strategy === "single") {
            startDate = parseDate(body.start);
            endDate = parseDate(body.end);
            if (!startDate || !endDate || new Date(endDate) <= new Date(startDate)) {
                return response.status(400).json({ ok: false, msg: "single needs start and end, end after start" });
            }
        }

        const userID = await getOwnerUserID();
        const obj = {
            title,
            description: typeof body.description === "string" ? body.description : "",
            strategy,
            intervalDay: 1,
            timezoneOption: typeof body.timezone === "string" ? body.timezone : null,
            active: body.active === true,
            dateRange: [startDate, endDate],
            timeRange: [],
            weekdays: [],
            daysOfMonth: [],
            durationMinutes: 0,
            cron: "",
        };

        let bean = await Maintenance.jsonToBean(R.dispense("maintenance"), obj);
        bean.user_id = userID;
        let maintenanceID = await R.store(bean);

        await replaceLinks(maintenanceID, monitorIDs, statusPageIDs);

        server.maintenanceList[maintenanceID] = bean;
        await bean.run(true);

        apicache.clear();
        await server.sendMaintenanceListByUserID(userID);

        response.status(201).json({ ok: true, maintenanceID });
    } catch (e) {
        log.error("maintenance-api", e);
        response.status(500).json({ ok: false, msg: "Internal error" });
    }
});

/**
 * Load a maintenance by id from the running server.
 * @param {string} id Maintenance id from URL
 * @returns {object|null} Maintenance bean or null
 */
function findMaintenance(id) {
    return server.getMaintenance(Number(id));
}

router.post("/api/maintenance/:id/resume", async (request, response) => {
    try {
        const maintenance = findMaintenance(request.params.id);
        if (!maintenance) {
            return response.status(404).json({ ok: false, msg: "Maintenance not found" });
        }

        maintenance.active = true;
        await R.store(maintenance);
        await maintenance.run();

        apicache.clear();
        await server.sendMaintenanceListByUserID(maintenance.user_id);

        response.json({ ok: true, maintenanceID: maintenance.id, active: true });
    } catch (e) {
        log.error("maintenance-api", e);
        response.status(500).json({ ok: false, msg: "Internal error" });
    }
});

router.post("/api/maintenance/:id/pause", async (request, response) => {
    try {
        const maintenance = findMaintenance(request.params.id);
        if (!maintenance) {
            return response.status(404).json({ ok: false, msg: "Maintenance not found" });
        }

        maintenance.active = false;
        await R.store(maintenance);
        maintenance.stop();

        apicache.clear();
        await server.sendMaintenanceListByUserID(maintenance.user_id);

        response.json({ ok: true, maintenanceID: maintenance.id, active: false });
    } catch (e) {
        log.error("maintenance-api", e);
        response.status(500).json({ ok: false, msg: "Internal error" });
    }
});

router.delete("/api/maintenance/:id", async (request, response) => {
    try {
        const maintenanceID = Number(request.params.id);
        const maintenance = server.getMaintenance(maintenanceID);
        if (!maintenance) {
            return response.status(404).json({ ok: false, msg: "Maintenance not found" });
        }

        const userID = maintenance.user_id;
        maintenance.stop();
        delete server.maintenanceList[maintenanceID];
        await R.exec("DELETE FROM maintenance WHERE id = ?", [maintenanceID]);

        apicache.clear();
        await server.sendMaintenanceListByUserID(userID);

        response.json({ ok: true, maintenanceID });
    } catch (e) {
        log.error("maintenance-api", e);
        response.status(500).json({ ok: false, msg: "Internal error" });
    }
});

module.exports = router;
