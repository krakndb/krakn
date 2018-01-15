"use strict";

const debug = require("debug")("yildiz:procedure:depthtransfer");
const Procedure = require("./Procedure.js");

const DEFAULT_DEPTH_MIN_AGE_MINUTES = 5;
const DEFAULT_MIN_AGE_TYPE = "MINUTE";

const SUPPORTED_AGE_TYPES = [
    "MINUTE",
    "SECOND",
    "HOUR",
    "DAY"
];

class DepthTransfer extends Procedure {

    constructor(yildiz, config = {}){
        super("y_depth_transfer", yildiz);

        this.minAge = config.minAge || DEFAULT_DEPTH_MIN_AGE_MINUTES;
        this.minAgeType = config.minAgeType || DEFAULT_MIN_AGE_TYPE;

        if(SUPPORTED_AGE_TYPES.indexOf(this.minAgeType) === -1){
            throw new Error("minAgeType must be one of the following: " + 
                SUPPORTED_AGE_TYPES.join(", ") + "; input: " + this.minAgeType +
                " is therefor not supported.");
        }
    }

    async call(edgeId){
        const startTime = Date.now();
        const upsert = `CALL ${super.getName()}(:edgeId);`;
        return await this.yildiz.raw(upsert, {
            edgeId
        }).then(results => {

            if(!results || !Array.isArray(results) ||
                typeof results[0] !== "object" || !results[0]){
                    debug("Procedure result was malformed.", results);
                    throw new Error("Procedure result was malformed.");
                }

            const [result, _] = results;
            const {depthCount} = result["0"];

            const diff = Date.now() - startTime;
            debug("procedure call took", diff, "ms");

            return {
                depthCount
            };
        });
    }

    async storeProcedure(force = false){

        const edgeTable = `${this.yildiz.prefix}_edges`;
        const depthTable = `${this.yildiz.prefix}_depths`;

        try {

            if(force){
                await this.yildiz.spread(`DROP PROCEDURE IF EXISTS ${super.getName()};`);
            }
    
            const doesExist = await super.procedureExists();
            if(doesExist){
                debug(super.getName(), "procedure already exists.");
                return;
            }
        } catch(error){
            debug("Failed to check for procedure status", super.getName(), error.message);
            return;
        }

        const procedure = `CREATE PROCEDURE ${super.getName()}
            (
                IN edgeId BIGINT(20)
            )
            BEGIN
                DECLARE depthCount INT(8);

                DECLARE EXIT HANDLER FOR 1001
                BEGIN
                    ROLLBACK;
                    RESIGNAL;
                END;

                DECLARE EXIT HANDLER FOR SQLEXCEPTION 
                BEGIN
                    ROLLBACK;
                    RESIGNAL;
                END;

                SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
                START TRANSACTION;

                SELECT COUNT(1) INTO depthCount
                FROM ${depthTable}
                WHERE created_at < DATE_SUB(NOW(), INTERVAL ${this.minAge} ${this.minAgeType})
                AND edge_id = edgeId;

                IF (depthCount > 0) THEN

                    UPDATE ${edgeTable}
                    SET depth = depth + depthCount
                    WHERE id = edgeId;

                    DELETE FROM ${depthTable}
                    WHERE created_at < DATE_SUB(NOW(), INTERVAL ${this.minAge} ${this.minAgeType})
                    AND edge_id = edgeId;
                END IF;

                COMMIT;
                SELECT depthCount;
            END`;

        debug("storing procedure");
        return await this.yildiz.spread(procedure);
    }
}

module.exports = DepthTransfer;