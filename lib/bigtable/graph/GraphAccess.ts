import Debug from "debug";
import Bluebird from "bluebird";

import { strToInt } from "./../../utils";
import { Yildiz } from "../Yildiz";
import { Metrics } from "../metrics/Metrics";
import { LookupCache } from "../cache/LookupCache";
import { UpsertConfig } from "../../interfaces/ServiceConfig";
import { FetchJob } from "../cache/FetchJob";
import { NodeHandler } from "./NodeHandler";

import { GenericObject, AnyObject } from "../../interfaces/Generic";

import {
    YildizSingleSchema,
    YildizResultSchema,
    YildizUpsertSchema,
} from "../../interfaces/Yildiz";
import { EdgeRaw, NodeEdgeUpsert } from "../../interfaces/Graph";

const debug = Debug("yildiz:graphaccess");

export class GraphAccess {

    private yildiz: Yildiz;
    private metrics: Metrics;
    private lookupCache: LookupCache;
    private upsertConfig: UpsertConfig | {};
    private fetchJob: FetchJob;

    private nodeHandler!: NodeHandler;

    private promiseConcurrency: number;

    constructor(yildiz: Yildiz) {
        this.yildiz = yildiz;
        this.metrics = this.yildiz.metrics;
        this.lookupCache = this.yildiz.lookupCache;
        this.fetchJob = this.yildiz.fetchJob;
        this.upsertConfig = this.yildiz.config.upsert || {};
        this.promiseConcurrency = this.yildiz.config.promiseConcurrency || 1000;
    }

    private async fullDataResolver(identifier: string, noMemoryCache?: boolean) {

        const node = await this.nodeHandler.getNodeByIdentifier(strToInt(identifier) + "", noMemoryCache);

        if (!node) {
            // Remove the fetchingJob list if exists
            try {
                await Bluebird.all([
                    this.yildiz.redisClient.clearCacheRefresh(identifier),
                    this.yildiz.redisClient.clearLastAccess(identifier),
                ]);
            } catch (error) {
                debug(error);
            }
            return;
        }

        const edges = [];
        const rawOtherNodeIdentifiers: string[] = [];

        const nodeKeys = Object.keys(node)
            .filter((nodeKey: string) => nodeKey.includes("ec") || nodeKey.includes("ed"));

        // If no other nodeKeys found just return the current node
        if (!nodeKeys.length) {

            // Only put the data if it is not null and not empty object
            if (node.data) {
                if (typeof node.data === "object") {
                    if (Object.keys(node.data).length) {
                        node.data = node.data;
                    } else {
                        delete node.data;
                    }
                } else {
                    // If number of string put it as data field
                    node.data = node.data;
                }
            } else {
                delete node.data;
            }

            delete node.ttld;

            return {
                identifier: node.identifier,
                value: node.value,
                nodes: node
            };
        }

        for (const nodeKey of nodeKeys) {

            const rightNodeId = nodeKey.split("#")[1];
            const relation = nodeKey.split("#")[2];

            const edgeObj: EdgeRaw = {
                leftNodeId: node.identifier,
                rightNodeId,
                data: node[nodeKey],
            };

            // Improve performance
            if ((this.upsertConfig as UpsertConfig).getEdgeTime && node.identifier) {
                edgeObj.edgeTime = await this.nodeHandler
                    .getEdgeTime(node.identifier, rightNodeId, relation);
            }

            if (relation) {
                edgeObj.relation = relation;
            }

            // Push only if it is edges
            edges.push(edgeObj);

            rawOtherNodeIdentifiers.push(nodeKey.split("#")[1]);
        }

        // Remove duplicates of right nodes
        const otherNodeIdentifiers = rawOtherNodeIdentifiers
            .filter((item, pos) => rawOtherNodeIdentifiers.indexOf (item) === pos);

        // Get the right node from cache or resolve them from node table
        const otherNodes = await this.getRightNodes(otherNodeIdentifiers, noMemoryCache);

        // Set the current node data in object
        const currentNode: YildizSingleSchema = {
            identifier: node.identifier,
            value: node.value,
        };

        // Only put the data if it is not null and not empty object
        if (node.data) {
            if (typeof node.data === "object") {
                if (Object.keys(node.data).length) {
                    currentNode.data = node.data;
                }
            } else {
                // If number of string put it as data field
                currentNode.data = node.data;
            }
        }

        const result = {
            identifier: node.identifier,
            value: node.value,
            edges,
            nodes: [currentNode].concat(otherNodes),
        };

        await this.nodeHandler.createCache(result);

        return result;
    }

    private async resolveOrBump(identifier: string) {

        const noMemoryCache = true;

        const bumped = await this.nodeHandler.bumpCacheByIdentifier(identifier);

        if (!bumped) {
            return this.fullDataResolver(identifier + "", noMemoryCache);
        }
    }

    public async init() {
        this.nodeHandler = await this.yildiz.getNodeHandler();
    }

    public setLastAccessFireAndForget(values: string[]) {
        const nodeIdentifiers = values.map((value: string) => strToInt(value) + "");
        this.fetchJob.bumpTTL(nodeIdentifiers)
            .catch((error) => {
                // Do nothing
            });
    }

    public async getRightNodes(identifiers: string[], noMemoryCache?: boolean) {

        // Get the other nodes data
        // cache will contain an array of object data of resolved right node
        // nocache will contain an array of key of unresolved right node
        const start = Date.now();
        const {cache, nocache} = await this.lookupCache.classifyRightNode(identifiers);

        this.metrics.inc("resolvedRightNode_cache_hits", cache.length);
        this.metrics.inc("resolvedRightNode_cache_miss", nocache.length);

        // Return if everything is in cache
        if (!nocache.length) {
            return cache;
        }

        // Resolve the right node if it is not in cache
        const nocacheNodes = (await Bluebird
                .map(
                    nocache,
                    (identifier: string) => this.nodeHandler.getNodeByIdentifier(identifier, noMemoryCache),
                    {
                        concurrency: this.promiseConcurrency,
                    },
                )
            )
            .filter((node) => !!node)
            .map((node) => {

                if (!node) {
                    return;
                }

                const nodeObj: YildizSingleSchema = {
                    identifier: node.identifier,
                    value: node.value,
                };

                // Only put the data if it is not null and not empty object
                if (node.data) {
                    if (typeof node.data === "object") {
                        if (Object.keys(node.data).length) {
                            nodeObj.data = node.data;
                        }
                    } else {
                        nodeObj.data = node.data;
                    }
                }

                return nodeObj;
            });

        // Set them in cache
        await this.lookupCache.setRightNode(nocacheNodes);

        this.metrics.inc("fetch_rightNodes_count");
        this.metrics.inc("fetch_rightNodes_time", Date.now() - start);

        // Concat the result
        return nocacheNodes.concat(cache);
    }

    public async buildAndCacheNodes(identifiers: string[]): Promise<void> {

        // Resolve all promises as the array will contain Promise as element
        (await Bluebird
            .map(
                identifiers,
                (identifier: string) => this.resolveOrBump(identifier + ""),
                {
                    concurrency: this.promiseConcurrency,
                },
            )
        );
    }

    public async getBuiltNodes(identifiers: string[]): Promise<YildizSingleSchema[]> {

        // Resolve all promises as the array will contain Promise as element
        return (await Bluebird
                .map(
                    identifiers,
                    (identifier: string) => this.fullDataResolver(identifier + ""),
                    {
                        concurrency: this.promiseConcurrency,
                    },
                )
            )
            .filter((result) => !!result) as YildizSingleSchema[];
    }

    private buildResult(resultArray?: AnyObject[]) {

        if (!resultArray || !resultArray.length) {
            return;
        }

        const filteredResultArray = resultArray
            .filter((singleResult) => !!singleResult);

        if (!filteredResultArray || !filteredResultArray.length) {
            return;
        }

        const result: YildizResultSchema = {};

        // Build identifiers field
        result.identifiers = filteredResultArray
            .map((singleResult) => {
                return {
                    identifier: singleResult.identifier,
                    value: singleResult.value,
                };
            });

        // Remove duplicate of nodes field
        const seenNodes: GenericObject = {};
        result.nodes = [].concat(...filteredResultArray
            .map((flattenResults) => flattenResults.nodes))
            .filter((singleResult: YildizSingleSchema) => {

                if (!singleResult || !singleResult.identifier) {
                    return;
                }

                const exists = seenNodes[singleResult.identifier];
                if (!exists) {
                    seenNodes[singleResult.identifier] = true;
                }
                return !exists;
            });

        // Remove duplicate of edges field
        const seenEdges: GenericObject = {};
        result.edges = [].concat(...filteredResultArray
            .map((flattenResults) => flattenResults.edges))
            .filter((singleResult: YildizSingleSchema) => {

                if (!singleResult) {
                    return;
                }

                const key = `${singleResult.leftNodeId}_${singleResult.rightNodeId}_${singleResult.relation}`;
                const exists = seenEdges[key];
                if (!exists) {
                    seenEdges[key] = true;
                }
                return !exists;
            });

        return result;
    }

    public async bumpCacheIfExists(values = []) {

        if (!Array.isArray(values)) {
            throw new Error("values must be an array");
        }

        if (!values.length) {
            throw new Error("values should not be empty");
        }

        const nodeIdentifiers = values.map((value) => strToInt(value) + "");
        const {cache, nocache} = await this.lookupCache.classifyExistence(nodeIdentifiers);

        this.metrics.inc("resolvedNodes_cache_hits", cache.length);
        this.metrics.inc("resolvedNodes_cache_miss", nocache.length);

        if (!cache.length) {
            return;
        }

        return await Bluebird.map(
            cache,
            (identifier: string) => this.nodeHandler.bumpCacheByIdentifier(identifier),
            {
                concurrency: this.promiseConcurrency,
            },
        ).catch((error) => {/* Ignore the error if it doesn't exist*/});
    }

    public async edgeInfoForNodesRelatingToTranslateValues(values = []) {

        if (!Array.isArray(values)) {
            throw new Error("values must be an array");
        }

        if (!values.length) {
            throw new Error("values should not be empty");
        }

        let cacheResults: YildizSingleSchema[] = [];
        const start = Date.now();

        const nodeIdentifiers = values.map((value) => strToInt(value) + "");
        const {cache, nocache} = await this.lookupCache.classifyExistence(nodeIdentifiers);

        this.metrics.inc("resolvedNodes_cache_hits", cache.length);
        this.metrics.inc("resolvedNodes_cache_miss", nocache.length);

        // Only get the cache from bigtable if the cache exists after checking in redis
        if (cache.length) {

            // Get the cache from cache table in bigtable
            cacheResults = await Bluebird.map(
                cache,
                (identifier: string) => this.nodeHandler.getCacheByIdentifier(identifier),
                {
                    concurrency: this.promiseConcurrency,
                },
            );

            const errorKeys: Array<string | number> = [];

            // Return error if there is an empty result from bigtable
            cacheResults.map((cacheResult, index) => {

                if (!cacheResult) {
                    errorKeys.push(cache[index]);
                    nocache.push(cache[index]);
                }
            });

            // Throw error if exists
            if (errorKeys.length) {
                debug(`Cache in Bigtable does not exist for keys ${errorKeys.join(",")}`);
            }

        }

        // If everything is in the cache, just return the cache
        if (!nocache.length) {
            const resultCache = this.buildResult(cacheResults);
            this.metrics.set("translated_edge_info_duration", Date.now() - start);
            return resultCache;
        }

        // Get the uncache node
        const resultArray: YildizSingleSchema[] = await this.getBuiltNodes(nocache);

        // Concat the resultArray with the one in cache and build expected result
        const result = this.buildResult(
            resultArray.concat(cacheResults),
        );

        if ((this.upsertConfig as UpsertConfig).translatedEdgeDebug) {
            debug(`translated edge info took ${Date.now() - start} ms`);
        }

        this.metrics.set("translated_edge_info_duration", Date.now() - start);

        return result;
    }

    public async upsertSingleEdgeRelationBetweenNodes(body: NodeEdgeUpsert): Promise<YildizUpsertSchema> {
        const start = Date.now();

        if (!body || typeof body !== "object") {
            return Promise.reject(new Error("Body must be an object."));
        }

        const {
            leftNodeIdentifierVal,
            rightNodeIdentifierVal,
            leftNodeData,
            rightNodeData,
            ttld,
            relation,
            edgeData,
            depthBeforeCreation,
            isPopularRightNode,
            edgeTime,
        } = body;

        const presumedNodeLeft = strToInt(leftNodeIdentifierVal) + "";
        const presumedNodeRight = strToInt(rightNodeIdentifierVal) + "";

        // Check node table from the presumed id from translates table if they exist
        const [
            nodeLeftExists,
            nodeRightExists, 
        ] = await Bluebird.all([
            this.nodeHandler.doesNodeExist(presumedNodeLeft),
            this.nodeHandler.doesNodeExist(presumedNodeRight),
        ]);

        // If the nodes don't exist create them
        await Bluebird.all([
            nodeLeftExists ? Promise.resolve() :
                this.nodeHandler.createNode(presumedNodeLeft, leftNodeData, {}, ttld, leftNodeIdentifierVal),
            nodeRightExists ? Promise.resolve() :
                this.nodeHandler.createNode(presumedNodeRight, rightNodeData, {}, ttld, rightNodeIdentifierVal),
        ]);

        // If NOT depthBeforeCreation, simply create a new edge
        let edge = null;

        if (!depthBeforeCreation) {
            const edgeId = await this.nodeHandler
                .createEdgeWithId(
                    presumedNodeLeft,
                    presumedNodeRight,
                    relation,
                    edgeData,
                    {},
                    ttld,
                    depthBeforeCreation,
                    isPopularRightNode,
                    edgeTime,
                );
            edge = {
                edgeId,
                leftNodeId: presumedNodeLeft,
                rightNodeId: presumedNodeRight,
            };
        } else {

            // If depthBeforeCreation get the edge
            // It's fine to not select for relation here,
            // because in depthBeforeCreation mode there should only be one single edge for two nodes
            const edges = await this.nodeHandler.edgeExistsId(presumedNodeLeft, presumedNodeRight);
            let edgeId = null;

            // If edge doesn't exist, create the edge
            if (!edges) {
                edgeId = await this.nodeHandler
                    .createEdgeWithId(
                        presumedNodeLeft,
                        presumedNodeRight,
                        relation,
                        edgeData,
                        {},
                        ttld,
                        depthBeforeCreation,
                        isPopularRightNode,
                        edgeTime,
                    );
            } else {
                edgeId = (await this.nodeHandler
                    .increaseEdgeDepthById(
                        presumedNodeLeft,
                        presumedNodeRight,
                        isPopularRightNode,
                        edgeTime,
                    )).edges;
            }

            edge = {
                edgeId,
                leftNodeId: presumedNodeLeft,
                rightNodeId: presumedNodeRight,
            };
        }

        const diff = (new Date()).getTime() - start;
        const withOrWithout = depthBeforeCreation ? "with" : "without";

        this.yildiz.metrics.set(`upsert_${withOrWithout}_depthBeforeCreation_duration`, diff);

        if (diff > 1000) {
            debug(`edge upsert took too long, ${diff} ms`, body);
        } else {

            if ((this.upsertConfig as UpsertConfig).upsertDebug) {
                debug(`edge upsert took ${diff} ms`);
            }
        }

        return edge;
    }

    public async runUpsertRelationWithRetry(body: NodeEdgeUpsert, retry?: number): Promise<YildizUpsertSchema> {

        try {
            const result = await this.upsertSingleEdgeRelationBetweenNodes(body);
            return result;
        } catch (error) {

            if (error.message.toLowerCase().includes("redis")) {
                this.yildiz.incStat("redis_error");
            }

            if (!retry) {
                retry = 0;
            }

            // If more than two times retry, throw error
            if (retry === 2) {
                throw error;
            }

            retry++;

            return this.runUpsertRelationWithRetry(body, retry);
        }
    }
}
