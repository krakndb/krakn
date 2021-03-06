import Debug from "debug";
import Bluebird from "bluebird";

import { ServiceConfig } from "../../interfaces/ServiceConfig";
import { Yildiz } from "../Yildiz";
import { Metrics } from "../metrics/Metrics";
import { RedisClient } from "./RedisClient";
import { GraphAccess } from "../graph/GraphAccess";

const debug = Debug("yildiz:fetchjob");

const DEFAULT_EXP_IN_SEC = 60 * 60 * 72; // 72 hours
const DEFAULT_FETCH_INTERV_IN_SEC = 3;
const DEFAULT_FETCH_LAST_ACCESS = 180;
const DEFAULT_FETCH_LIMIT = 20;

export class FetchJob {

  private yildiz: Yildiz;
  private config: ServiceConfig;
  private metrics: Metrics;
  private redisClient: RedisClient;

  private expireInSec: number;
  private fetchIntervalInSec: number;
  private fetchLastAccess: number;
  private limit: number;
  private resolveNodes: boolean;
  private alwaysAwaiting: boolean;
  private jobActive: boolean;
  private fullDebug: boolean;

  private tov!: NodeJS.Timer | number;
  private graphAccess!: GraphAccess;

  constructor(yildiz: Yildiz, metrics: Metrics, redisClient: RedisClient) {

    this.redisClient = redisClient;
    this.yildiz = yildiz;
    this.config = yildiz.config;
    this.metrics = metrics;

    this.jobActive = this.config.fetchJob ? true : false;

    const {
      expireInSec = DEFAULT_EXP_IN_SEC,
      fetchIntervalInSec = DEFAULT_FETCH_INTERV_IN_SEC,
      fetchLastAccess = DEFAULT_FETCH_LAST_ACCESS,
      limit = DEFAULT_FETCH_LIMIT,
      resolveNodes = false,
      alwaysAwaiting = false,
      fullDebug = false,
    } = this.config.fetchJob || {};

    // How long the keys are going to expire in redis
    this.expireInSec = expireInSec;

    // Fetch Interval for job
    this.fetchIntervalInSec = fetchIntervalInSec;

    // How long the cache is stored until it should be fetched again
    this.fetchLastAccess = fetchLastAccess;

    // Limit in retrieving the lastAccess nodeId from redis
    this.limit = limit;

    this.resolveNodes = resolveNodes;
    this.alwaysAwaiting = alwaysAwaiting;
    this.fullDebug = fullDebug;
  }

  private resetJob() {

    this.tov = setTimeout(async () => {

      try {
        const startJob = Date.now();
        await this.jobAction(startJob, 0);
      } catch (error) {
        debug("error while running job", error);
        this.resetJob();
      }

    }, this.fetchIntervalInSec * 1000);
  }

  private async jobAction(startJob: number, keysTotal: number): Promise<void> {

    let keys = null;

    try {
      keys = await this.getKeysToBeCached();
    } catch (error) {
      debug("error occurred when getting keys", error.message);
    }

    // Reset the job if the keys need to be cached
    if (!keys || !keys.length) {
      this.metrics.inc("fetchJob_runs");
      this.metrics.inc("fetchJob_duration", Date.now() - startJob);
      if (this.fullDebug) {
        debug(`fetchJob done cached ${keysTotal} keys, took ${Date.now() - startJob} ms`);
      }
      return this.resetJob();
    }

    keysTotal +=  keys.length;

    try {
      const startBatch = Date.now();
      if (this.resolveNodes) {
        await this.graphAccess.buildAndCacheNodes(keys);
      } else {
        await this.graphAccess.bumpCacheIfExists(keys);
      }
      this.metrics.inc("resolvingBatch_duration", Date.now() - startBatch);
    } catch (error) {
      debug("error occurred while caching", error.message);
    }

    if (this.alwaysAwaiting) {
      return await this.jobAction(startJob, keysTotal);
    } else {
      return this.jobAction(startJob, keysTotal);
    }

  }

  private async getKeysToBeCached() {

    // Remove the keys from last LASTACCESS_SET that has expired
    const lastAccess = Date.now() - (this.fetchLastAccess * 1000);
    const removedCounts = await this.redisClient.clearLastAccessByExpiry(this.expireInSec * 1000);

    if (removedCounts) {
      this.metrics.inc("fetchJob_removed_keys", removedCounts);
      debug(`expired keys found from LASTACCESS_SET, removed ${removedCounts} keys`);
    }

    const [accessedKeys, refreshKeys, recentlyRefreshedKeys] = await Bluebird.all([
      this.redisClient.getLastAccess(lastAccess, this.limit),
      this.redisClient.getCacheRefresh(lastAccess, this.limit),
      this.redisClient.getRecentCacheRefresh(lastAccess),
    ]);

    // If there are no keys found, return empty array
    if ((!refreshKeys || !refreshKeys.length) && (!accessedKeys || !accessedKeys.length)) {
      return [];
    }

    // Remove the keys from CACHEREFRESH_SET because if it is not in LASTACCESS_SET it means it is no longer valid
    if (refreshKeys.length && (!accessedKeys || !accessedKeys.length)) {
      debug(`expired keys found from CACHEREFRESH_SET, removed ${refreshKeys.length} keys`);

      await this.redisClient.clearCacheRefresh(refreshKeys);
      this.metrics.inc("fetchJob_removed_keys", refreshKeys.length);

      return [];
    }

    // Get the intersection
    // If LASTACCESS_SET union CACHEREFRESH_SET and not in recentlyRefreshedKeys (not recently refreshed)
    // and curb the limit
    const keysToBeCached = accessedKeys
      .concat(refreshKeys || [])
      .filter((value: string) => recentlyRefreshedKeys.indexOf(value) === -1)
      .slice(0, this.limit);
    if (!keysToBeCached || !keysToBeCached.length) {
      return [];
    }

    // add the keys with the keys of CACHEREFRESH_SET to be cached
    await this.redisClient.setCacheRefresh(keysToBeCached);

    // If CACHEREFRESH_SET not in LASTACCESS_SET, remove the keys from CACHEREFRESH_SET
    const keysToBeRemoved = keysToBeCached
      .filter((value: string) => accessedKeys.indexOf(value) === -1);
    if (keysToBeRemoved.length) {
      debug(`expired keys found from CACHEREFRESH_SET, removed ${keysToBeRemoved.length} keys`);
      await this.redisClient.clearCacheRefresh(keysToBeRemoved);
      this.metrics.inc("fetchJob_removed_keys", keysToBeRemoved.length);
    }

    const keysToBeCachedLength = keysToBeCached.length;

    if (this.fullDebug) {
      debug("fetchJob_caching_keys", keysToBeCachedLength);
    }
    this.metrics.inc("fetchJob_caching_keys", keysToBeCachedLength);

    // Otherwise cache the keys
    return keysToBeCached;
  }

  public async init() {

    if (!this.jobActive) {
      return;
    }

    this.graphAccess = await this.yildiz.getGraphAccess();
    debug(`Running job to cache nodes every ${this.fetchIntervalInSec} seconds`);
    debug(`Job awaiting to complete is set to ${this.alwaysAwaiting}`);
    debug(`Resolving Full Node is set to ${this.resolveNodes}`);
    this.resetJob();
  }

  public async bumpTTL(key: string | string[]) {
    await this.redisClient.setLastAccess(key);
  }

  public async close() {
    if (this.tov) {
      clearTimeout(this.tov as NodeJS.Timer);
    }
  }
}
