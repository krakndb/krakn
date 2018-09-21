import Debug from "debug";
import Bigtable from "@google-cloud/bigtable";

import { Yildiz } from "../Yildiz";
import {
    generateId,
    strToInt,
} from "./../../utils";

import { Metadata } from "../db/Metadata";
import { Metrics } from "../metrics/Metrics";
import { DatabaseConfig } from "../../interfaces/ServiceConfig";

import { GenericObject, AnyObject } from "../../interfaces/Generic";
import { YildizSingleSchema } from "../../interfaces/Yildiz";
import { EdgeCache } from "../../interfaces/Graph";

const debug = Debug("yildiz:nodehandler");

const ED = "ed";
const EC = "ec";

export class NodeHandler {

    private yildiz: Yildiz;
    private metadata: Metadata;
    private metrics: Metrics;
    private dbConfig: DatabaseConfig;

    private nodeTable: Bigtable.Table;
    private ttlTable: Bigtable.Table;
    private popnodeTable: Bigtable.Table;
    private cacheTable: Bigtable.Table;
    private columnFamilyNode: Bigtable.Family;
    private columnFamilyTTL: Bigtable.Family;
    private columnFamilyPopnode: Bigtable.Family;
    private columnFamilyCache: Bigtable.Family;

    constructor(yildiz: Yildiz) {

        this.yildiz = yildiz;
        this.metadata = this.yildiz.metadata;
        this.metrics = this.yildiz.metrics;
        this.dbConfig = this.yildiz.config.database;

        // Get the Tables and CFs
        const {
            nodeTable,
            ttlTable,
            popnodeTable,
            cacheTable,
            columnFamilyNode,
            columnFamilyTTL,
            columnFamilyPopnode,
            columnFamilyCache,
        } = this.yildiz.models;

        // Tables
        this.nodeTable = nodeTable;
        this.ttlTable = ttlTable;
        this.popnodeTable = popnodeTable;
        this.cacheTable = cacheTable;

        // Column Families
        this.columnFamilyNode = columnFamilyNode;
        this.columnFamilyTTL = columnFamilyTTL;
        this.columnFamilyPopnode = columnFamilyPopnode;
        this.columnFamilyCache = columnFamilyCache;
    }

    private getParsedValue(value: string) {

        let result = value;

        try {
            result = JSON.parse(value);
        } catch (error) {
            // DO Nothing
        }

        return result;
    }

    private async getRow(identifier: string | number, table: any, cFName: string): Promise<YildizSingleSchema | null> {

        const result: YildizSingleSchema = { identifier, id: identifier };
        const row = table.row(identifier + "");
        let rowGet = null;

        try {
            rowGet = await row.get();
        } catch (error) {

            if (!error.message.startsWith("Unknown row")) {
                throw error;
            }

            // Set the result to null if it throws at row.get - Error: Unknown row
            return null;
        }

        if (
            rowGet &&
            rowGet[0] &&
            rowGet[0].data &&
            rowGet[0].data[cFName]
        ) {
            const rowData: any = rowGet[0].data[cFName];
            Object.keys(rowData).forEach((column: string) => {
                if (rowData[column] && rowData[column][0] && rowData[column][0].value) {
                    result[column] = this.getParsedValue(rowData[column][0].value);
                }
            });
        }

        return result;
    }

    private async updateEdgeOnNode(nodeId: string, edgeId: string) {

        const nodeRow = this.nodeTable.row(nodeId + "");
        const rules = [{
            column: `${this.columnFamilyNode.id}:edges`,
            append: edgeId + ",",
        }];

        return await nodeRow.createRules(rules);
    }

    /* ### EDGES ### */

    public async edgeExistsId(
        firstNodeId: string | number,
        secondNodeId: string | number,
        relation: number | string = 0): Promise<EdgeCache | null> {

        if (!firstNodeId || !secondNodeId) {
            throw new Error("missing left or right id params.");
        }

        if (relation === null) {
            throw new Error("relation can not be null");
        }

        if (isNaN(relation as number)) {
            relation = strToInt(relation);
        }

        const cacheKey = `gnbpf:identifier:${firstNodeId}:${secondNodeId}:${relation}`;
        const cacheResult = await this.yildiz.cache.getEdge(cacheKey);

        if (cacheResult) {
            return cacheResult as EdgeCache;
        }

        const start = Date.now();

        const cFName = this.columnFamilyNode.id;

        let resultLeft = [];
        let resultRight = [];

        const result: EdgeCache = {
            id: [],
            data: {},
        };

        // firstNode
        if (this.dbConfig.leftNodeEdge) {
            try {
                resultLeft = (await this.nodeTable.row(firstNodeId + "")
                    .get([
                        `${cFName}:${ED}#${secondNodeId}`,
                        `${cFName}:${EC}#${secondNodeId}#${relation}`,
                    ]))
                    .filter((resultLeftMember: AnyObject) => !!resultLeftMember)
                    .map((resultLeftMember: AnyObject) => resultLeftMember[cFName]);

                const key = Object.keys(resultLeft[0])[0];
                result.id.push(key);
                result.data[key] = resultLeft[0][key][0].value;
            } catch (error) {
                if (!error.message.startsWith("Unknown row")) {
                    debug("unable to get leftNode", error);
                }
            }
        }

        // secondNode
        if (this.dbConfig.rightNodeEdge) {
            try {
                resultRight = (await this.nodeTable.row(secondNodeId + "")
                .get([
                    `${cFName}:${ED}#${firstNodeId}`,
                    `${cFName}:${EC}#${firstNodeId}#${relation}`,
                ]))
                .filter((resultRightMember: AnyObject) => !!resultRightMember)
                .map((resultRightMember: AnyObject) => resultRightMember[cFName]);

                const key = Object.keys(resultRight[0])[0];
                result.id.push(key);
                result.data[key] = resultRight[0][key][0].value;
            } catch (error) {
                if (!error.message.startsWith("Unknown row")) {
                    debug("unable to get leftNode", error);
                }            }
        }

        if (!result.id.length) {
            return null;
        }

        await this.yildiz.cache.setEdge(cacheKey, result);

        this.yildiz.metrics.set("check_exists_edge", Date.now() - start);

        return result;
    }

    public async createEdgeWithId(
        firstNodeId: string | number,
        secondNodeId: string | number,
        relation: string | number = 0,
        attributes = {},
        extend: GenericObject = {},
        ttld = false,
        depthMode = false,
        isPopularRightNode = false,
        edgeTime?: string | number) {

        if (!firstNodeId || !secondNodeId) {
            throw new Error("missing left or right id params.");
        }

        if (relation === null) {
            throw new Error("relation can not be null");
        }

        if (isNaN(relation as number)) {
            relation = strToInt(relation);
        }

        if (isNaN(firstNodeId as number)) {
            firstNodeId = strToInt(firstNodeId);
        }

        if (isNaN(secondNodeId as number)) {
            secondNodeId = strToInt(secondNodeId);
        }

        const requests = [];
        const results = [];
        const val =  JSON.stringify(Object.assign({}, extend, attributes));

        if (this.dbConfig.leftNodeEdge) {

            // columnName is just like in the edge creation of rightNode, but the column identifier is reverse
            const columnName = `${depthMode ? ED : EC}#${secondNodeId}${depthMode ? "" : "#" + relation}`;
            const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
            const leftNodeId = firstNodeId + "";
            const row = this.nodeTable.row(leftNodeId);
            const saveData = {
                [this.columnFamilyNode.id]: {
                    [columnName]: val,
                },
            };

            results.push(qualifier);
            requests.push(depthMode ? row.increment(qualifier) : row.save(saveData));

            // Delete cache on left node if exists
            requests.push(this.yildiz.cache.del(`gnbpf:identifier:${firstNodeId}`));
            this.metrics.inc("edge_created_leftNode");

            if (ttld) {
                requests.push(this.ttlTable.insert([{
                    key: `${firstNodeId}-${columnName}_edges`,
                    data: {
                        [this.columnFamilyTTL.id] : {
                            value: "1",
                        },
                    },
                }]));
            }
        }

        if (this.dbConfig.rightNodeEdge) {

           // TODO: if popularRightEdge mode treat differently (currently just dont write it to db)
            if (!isPopularRightNode) {

                // If it is depthMode the columnName will be like ED#12345 where 12345 is the id (murmurhash) of left id
                // If it is NOT depthmode the columnName will be like EC#12345#456
                // where 12345 is the id (murmurhash) of left id and 456 is the id (murmurhash) of relation
                const columnName = `${depthMode ? ED : EC}#${firstNodeId}${depthMode ? "" : "#" + relation}`;
                const rightNodeId = secondNodeId + "";
                const row = this.nodeTable.row(rightNodeId);
                const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
                const saveData = {
                    [this.columnFamilyNode.id]: {
                        [columnName]: val,
                    },
                };

                results.push(qualifier);
                requests.push(depthMode ? row.increment(qualifier) : row.save(saveData));

                // Delete cache on right node if exists
                requests.push(this.yildiz.cache.del(`gnbpf:identifier:${secondNodeId}`));

                if (ttld) {
                    requests.push(this.ttlTable.insert([{
                        key: `${secondNodeId}-${columnName}_edges`,
                        data: {
                            [this.columnFamilyTTL.id] : {
                                value: "1",
                            },
                        },
                    }]));
                }

            } else {
                // Save popularnode edge data in separate table

                edgeTime = edgeTime || Date.now();

                const key = `${firstNodeId}#${secondNodeId}${depthMode ? "" : "#" + relation}`;
                const row = this.popnodeTable.row(key);
                const column = depthMode ? "depth" : "data";

                // If depthmode, we need to call increment and save the edgeTime with two calls
                if (depthMode) {
                    const qualifierData = `${this.columnFamilyPopnode.id}:${column}`;
                    requests.push(row.increment(qualifierData));

                    const saveData = {
                        [this.columnFamilyPopnode.id]: {
                            edgeTime,
                        },
                    };

                    requests.push(row.save(saveData));

                // Otherwise we just need to run insertion for both columns
                } else {
                    requests.push(this.popnodeTable.insert([{
                        key,
                        data: {
                            [this.columnFamilyPopnode.id] : {
                                [column]: val,
                                edgeTime,
                            },
                        },
                    }]));
                }

                if (ttld) {
                    requests.push(this.ttlTable.insert([{
                        key: key + "_popnodes",
                        data: {
                            [this.columnFamilyTTL.id] : {
                                value: "1",
                            },
                        },
                    }]));
                }
            }
            this.metrics.inc("edge_created_rightNode");
        }

        this.metrics.inc("edge_created");
        this.metadata.increaseCount("edges");
        await Promise.all(requests);

        return results;
    }

    public async getEdgesForLeftNode(id: string | number, relation: string | number = 0) {
        return await this.getEdgesforNode(id);
    }

    public async getEdgesForRightNode(id: string | number, relation: string | number = 0) {
        return await this.getEdgesforNode(id);
    }

    public async getEdgesForBothNode(id: string | number, relation: string | number = 0) {
        return await this.getEdgesforNode(id);
    }

    public async getEdgesforNode(id: string | number) {

        const results = [];
        const key = id + "";
        const row = await this.nodeTable.row(key).get();
        const cFName = this.columnFamilyNode.id;
        const edgesRaw = row[0].data[cFName];
        const edges: YildizSingleSchema[] = [];

        Object.keys(edgesRaw).map(
            (edgesRawKey) => {
                if (edgesRawKey.startsWith(EC) || edgesRawKey.startsWith(ED)) {
                    edges.push(edgesRaw[edgesRawKey][0].value);
                }
            },
        );

        return edges;
    }

    public async getEdgeCount() {
        return await this.metadata.getCount("edges");
    }

    public async increaseEdgeDepthById(
        firstNodeId: string | number,
        secondNodeId: string | number,
        isPopularRightNode = false,
        edgeTime?: string | number) {

        const requests = [];
        const edges = [];

        if (this.dbConfig.leftNodeEdge) {
            const columnName = `${ED}#${secondNodeId}`;
            const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
            const leftNodeId = firstNodeId + "";
            const row = this.nodeTable.row(leftNodeId);
            edges.push(qualifier);
            requests.push(row.increment(qualifier));

            // Delete cache on left node if exists
            requests.push(this.yildiz.cache.del(`gnbpf:identifier:${firstNodeId}`));
        }

        if (this.dbConfig.rightNodeEdge) {

            if (!isPopularRightNode) {
                const columnName = `${ED}#${firstNodeId}`;
                const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
                const rightNodeId = secondNodeId + "";
                const row = this.nodeTable.row(rightNodeId);
                edges.push(qualifier);
                requests.push(row.increment(qualifier));

                // Delete cache on right node if exists
                requests.push(this.yildiz.cache.del(`gnbpf:identifier:${firstNodeId}`));
            } else {
                edgeTime = edgeTime || Date.now();
                const key = `${firstNodeId}#${secondNodeId}`;
                const row = this.popnodeTable.row(key);

                const qualifierData = `${this.columnFamilyPopnode.id}:depth`;
                requests.push(row.increment(qualifierData));

                const saveData = {
                    [this.columnFamilyPopnode.id]: {
                        edgeTime,
                    },
                };

                requests.push(row.save(saveData));
            }
        }

        try {
            await Promise.all(requests);
        } catch (error) {
            debug("Error while saving row" + error);
            return {
                success: false,
            };
        }

        return {
            success: true,
            edges,
        };
    }

    public async decreaseEdgeDepthById(
        firstNodeId: string | number,
        secondNodeId: string | number,
        isPopularRightNode = false,
        edgeTime?: string | number) {

        const requests = [];
        const edges = [];

        if (this.dbConfig.leftNodeEdge) {
            const columnName = `${ED}#${secondNodeId}`;
            const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
            const leftNodeId = firstNodeId + "";
            const row = this.nodeTable.row(leftNodeId);
            edges.push(qualifier);
            requests.push(row.increment(qualifier, -1));

            // Delete cache on left node if exists
            requests.push(this.yildiz.cache.del(`gnbpf:identifier:${firstNodeId}`));

        }

        if (this.dbConfig.rightNodeEdge) {
            if (!isPopularRightNode) {
                const columnName = `${ED}#${firstNodeId}`;
                const qualifier = `${this.columnFamilyNode.id}:${columnName}`;
                const rightNodeId = secondNodeId + "";
                const row = this.nodeTable.row(rightNodeId);
                edges.push(qualifier);
                requests.push(row.increment(qualifier, -1));

                // Delete cache on right node if exists
                requests.push(this.yildiz.cache.del(`gnbpf:identifier:${firstNodeId}`));
            } else {
                edgeTime = edgeTime || Date.now();
                const key = `${firstNodeId}#${secondNodeId}`;
                const row = this.popnodeTable.row(key);

                const qualifierData = `${this.columnFamilyPopnode.id}:depth`;
                requests.push(row.increment(qualifierData, -1));

                const saveData = {
                    [this.columnFamilyPopnode.id]: {
                        edgeTime,
                    },
                };

                requests.push(row.save(saveData));
            }
        }

        try {
            await Promise.all(requests);
        } catch (error) {
            debug("Error while saving row" + error);
            return {
                success: false,
            };
        }

        return {
            success: true,
            edges,
        };
    }

    public async removeEdgeByIds(
        firstNodeId: string | number,
        secondNodeId: string | number,
        relation: string | number = 0) {

        if (!firstNodeId || !secondNodeId) {
            throw new Error("missing left or right id params.");
        }

        if (relation === null) {
            throw new Error("relation can not be null");
        }

        const edge = await this.edgeExistsId(firstNodeId, secondNodeId, relation);

        if (!edge) {
            return null;
        }

        if (isNaN(relation as number)) {
            relation = strToInt(relation);
        }

        const cacheKey = `gnbpf:identifier:${firstNodeId}:${secondNodeId}:${relation}`;
        await this.yildiz.cache.del(cacheKey);

        const requests = [];
        const cFName = this.columnFamilyNode.id;

        if (this.dbConfig.leftNodeEdge) {

            const key = firstNodeId + "";
            const row = this.nodeTable.row(key);
            const cells = edge.id
                .filter((edgeId) => key !== (edgeId + "").split("#")[1])
                .map((edgeId) => `${cFName}:${edgeId}`);

            if (cells) {
                requests.push(row.deleteCells(cells));
            }
        }

        if (this.dbConfig.rightNodeEdge) {

            const key = secondNodeId + "";
            const row = this.nodeTable.row(key);
            const cells = edge.id
                .filter((edgeId) => key !== (edgeId + "").split("#")[1])
                .map((edgeId) => `${cFName}:${edgeId}`);

            if (cells) {
                requests.push(row.deleteCells(cells));
            }
        }

        this.metadata.decreaseCount("edges");

        return await Promise.all(requests);
    }

    public async getEdgeTime(firstNodeId: string | number, secondNodeId: string | number, relation?: string | number) {

        if (!firstNodeId || !secondNodeId) {
            throw new Error("missing left or right id params.");
        }

        const identifier = relation ? `${firstNodeId}#${secondNodeId}#${relation}` : `${firstNodeId}#${secondNodeId}`;

        const edge = await this.getRow(identifier, this.popnodeTable, this.columnFamilyPopnode.id);

        const timestamp = edge && edge.edgeTime || null;

        return timestamp;
    }

    /* ### NODES ### */

    public async createNode(
        identifier: string | number = generateId(),
        properties = {},
        extend: GenericObject = {},
        ttld = false,
        identifierValue: string | number) {

        const data = Object.assign({}, extend, properties);
        const ttldVal = ttld + "";
        const key = identifier + "";

        const val = {
            key,
            data: {
                [this.columnFamilyNode.id] : {
                    data: JSON.stringify(data),
                    ttld: ttldVal,
                    value: identifierValue,
                },
            },
        };
        const valTTL = {
            key: `${key}_nodes`,
            data: {
                [this.columnFamilyTTL.id] : {
                    value: "1",
                },
            },
        };

        const requests = [this.nodeTable.insert([val])];
        if (ttld) {
            requests.push(this.ttlTable.insert([valTTL]));
        }

        try {
            await Promise.all(requests);
        } catch (error) {
            return error;
        }

        this.metadata.increaseCount("nodes");
        this.metrics.inc("node_created");
        const result = await this.getNodeByIdentifier(key);

        return result;
    }

    public async removeNode(identifier: string | number) {

        const cacheKey = `gnbpf:identifier:${identifier}`;
        await this.yildiz.cache.del(cacheKey);

        const row = this.nodeTable.row(identifier + "");

        try {
            await row.get();
        } catch (error) {
            return null;
        }

        const result = await row.delete();

        this.metadata.decreaseCount("nodes");

        return result;
    }

    public async removeNodeComplete(identifier: string | number) {

        const row = this.nodeTable.row(identifier + "");

        try {
            await row.get();
        } catch (error) {
            return null;
        }

        const rowObject = await this.getNodeByIdentifier(identifier);

        if (!rowObject) {
            return null;
        }

        const popNodeKeys = Object.keys(rowObject)
            .filter((key) => key.includes(ED) || key.includes(EC))
            .map((key) => key.replace(/ed|ec/, identifier + ""));

        const cacheKey = `gnbpf:identifier:${identifier}`;
        await this.yildiz.cache.del(cacheKey);

        const deletion: Array<Promise<void | null>> = [
            row.delete(),
        ];

        popNodeKeys.map((key) => {
            deletion.push(this.removePopNode(key));
        });

        const result = await Promise.all(deletion);

        this.metadata.decreaseCount("nodes");
        this.metadata.decreaseCount("edges", popNodeKeys.length);

        return result;
    }

    public async removePopNode(identifier: string | number) {

        const row = this.popnodeTable.row(identifier + "");

        try {
            await row.get();
        } catch (error) {
            return null;
        }

        return await row.delete();
    }

    public async getNodeByIdentifier(identifier: string | number): Promise<YildizSingleSchema | null> {

        const cacheKey = `gnbpf:identifier:${identifier}`;
        const cacheResult = await this.yildiz.cache.getNode(cacheKey);

        if (cacheResult) {
            return cacheResult as YildizSingleSchema;
        }

        const start = Date.now();

        const node = await this.getRow(identifier, this.nodeTable, this.columnFamilyNode.id);

        if (!node) {
            return null;
        }

        await this.yildiz.cache.setNode(cacheKey, node);

        this.yildiz.metrics.set("get_node_by_identifier", Date.now() - start);

        return node;
    }

    public async doesNodeExist(identifier: string | number) {

        const key = identifier + "";

        const cacheKey = `gnbpf:exists:node:${identifier}`;
        const cacheResult = await this.yildiz.cache.getNode(cacheKey);

        // Only return from cache if it exists
        if (cacheResult) {
            return cacheResult;
        }

        const nodeExists = await this.nodeTable.row(key).exists();
        const exists = nodeExists && nodeExists[0];

        await this.yildiz.cache.setNode(cacheKey, exists);

        return exists;
    }

    public async getNodeCount() {
        return await this.metadata.getCount("nodes");
    }

    public async getCacheByIdentifier(identifier: string | number) {

        const start = Date.now();

        const cache = await this.getRow(identifier, this.cacheTable, this.columnFamilyCache.id);

        this.yildiz.metrics.set("get_cache_by_identifier", Date.now() - start);

        const result = cache && cache.value || null;

        return result;
    }

    public async createCache(cache?: YildizSingleSchema) {

        if (!cache) {
            return;
        }

        const start = Date.now();

        const row = this.cacheTable.row(cache.identifier + "");
        const cfName = this.columnFamilyCache.id;

        const rowTTL = this.ttlTable.row(`${cache.identifier}_caches`);
        const cfNameTTL = this.columnFamilyTTL.id;
        const saveDataTTL = {
            [cfNameTTL]: {
                value: "1",
            },
        };

        const saveData = {
            [cfName]: {
                value: JSON.stringify(cache),
            },
        };

        await Promise.all([
            row.save(saveData),
            rowTTL.save(saveDataTTL),
        ]);

        this.yildiz.metrics.set("save_cache_bigtable", Date.now() - start);

        return cache;
    }

}