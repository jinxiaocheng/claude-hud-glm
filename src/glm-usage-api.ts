import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import type { UsageData } from './types.js';
import { createDebug } from './debug.js';

const debug = createDebug('glm-usage');

// Coding Plan 配额接口响应
interface GlmQuotaApiResponse {
  code?: number;
  msg?: string;
  data?: {
    limits?: Array<{
      type: string;
      unit?: number;       // 3=5小时, 6=每周, 5=每月
      number?: number;     // 数量
      percentage: number;  // 使用百分比
      nextResetTime?: number; // 重置时间戳(ms)
      usage?: number;
      currentValue?: number;
      remaining?: number;
      usageDetails?: Array<{ modelCode: string; usage: number }>;
    }>;
    level?: string;
  };
}

interface ClaudeSettings {
  env?: {
    ANTHROPIC_AUTH_TOKEN?: string;
    ANTHROPIC_BASE_URL?: string;
  };
}

// File-based cache (HUD runs as new process each render, so in-memory cache won't persist)
const CACHE_TTL_MS = 60_000; // 60 seconds
const CACHE_FAILURE_TTL_MS = 15_000; // 15 seconds for failed requests

interface CacheFile {
  data: UsageData;
  timestamp: number;
}

function getCachePath(homeDir: string): string {
  return path.join(homeDir, '.claude', 'plugins', 'claude-hud', '.glm-usage-cache.json');
}

function readCache(homeDir: string, now: number): UsageData | null {
  try {
    const cachePath = getCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;

    const content = fs.readFileSync(cachePath, 'utf8');
    const cache: CacheFile = JSON.parse(content);

    // Check TTL - use shorter TTL for failure results
    const ttl = cache.data.apiUnavailable ? CACHE_FAILURE_TTL_MS : CACHE_TTL_MS;
    if (now - cache.timestamp >= ttl) return null;

    // JSON.stringify converts Date to ISO string, so we need to reconvert on read.
    const data = cache.data;
    if (data.fiveHourResetAt) {
      data.fiveHourResetAt = new Date(data.fiveHourResetAt);
    }
    if (data.sevenDayResetAt) {
      data.sevenDayResetAt = new Date(data.sevenDayResetAt);
    }

    return data;
  } catch {
    return null;
  }
}

function writeCache(homeDir: string, data: UsageData, timestamp: number): void {
  try {
    const cachePath = getCachePath(homeDir);
    const cacheDir = path.dirname(cachePath);

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const cache: CacheFile = { data, timestamp };
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    // Ignore cache write failures
  }
}

// Dependency injection for testing
export type GlmUsageApiDeps = {
  homeDir: () => string;
  fetchApi: (apiKey: string, baseUrl: string) => Promise<GlmQuotaApiResponse['data'] | null>;
  now: () => number;
  readSettings: () => ClaudeSettings | null;
};

const defaultDeps: GlmUsageApiDeps = {
  homeDir: () => os.homedir(),
  fetchApi: fetchGlmQuotaApi,
  now: () => Date.now(),
  readSettings: readClaudeSettings,
};

/**
 * Get GLM Coding Plan usage data from GLM API (open.bigmodel.cn or z.ai).
 * 调用 Coding Plan 配额接口，获取5小时和每周token用量百分比。
 * Returns null if not configured for GLM or API key is missing.
 * Returns { apiUnavailable: true, ... } if API call fails.
 *
 * Uses file-based cache since HUD runs as a new process each render (~300ms).
 * Cache TTL: 60s for success, 15s for failures.
 */
export async function getGlmUsage(overrides: Partial<GlmUsageApiDeps> = {}): Promise<UsageData | null> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const homeDir = deps.homeDir();

  // Check file-based cache first
  const cached = readCache(homeDir, now);
  if (cached) {
    return cached;
  }

  try {
    // Read Claude Code settings to get API key and base URL
    const settings = deps.readSettings();
    if (!settings?.env) {
      debug('No settings.env found');
      return null;
    }

    const apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    const baseUrl = settings.env.ANTHROPIC_BASE_URL;

    // 检查是否配置了 GLM (open.bigmodel.cn 或 z.ai)
    if (!apiKey || !baseUrl) {
      debug('No API key or base URL configured');
      return null;
    }

    if (!baseUrl.includes('bigmodel.cn') && !baseUrl.includes('z.ai')) {
      debug('Not configured for GLM API (bigmodel.cn or z.ai not found in base URL)');
      return null;
    }

    // 调用 Coding Plan 配额查询接口
    const apiResponse = await deps.fetchApi(apiKey, baseUrl);
    if (!apiResponse) {
      // API调用失败，缓存失败结果防止重试风暴
      const failureResult: UsageData = {
        planName: 'GLM',
        fiveHour: null,
        sevenDay: null,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        apiUnavailable: true,
      };
      writeCache(homeDir, failureResult, now);
      return failureResult;
    }

    // 解析 Coding Plan 配额响应
    // unit=3 → 5小时token滚动窗口
    // unit=6 → 每周token额度
    // unit=5 → MCP工具月度额度 (TIME_LIMIT)
    const limits = apiResponse.limits || [];
    let fiveHourPercent: number | null = null;
    let sevenDayPercent: number | null = null;
    let fiveHourResetAt: Date | null = null;
    let sevenDayResetAt: Date | null = null;

    for (const item of limits) {
      if (item.type === 'TOKENS_LIMIT') {
        if (item.percentage != null) {
          if (item.unit === 3) {
            // unit=3 → 5小时滚动窗口
            fiveHourPercent = item.percentage;
            if (item.nextResetTime) {
              fiveHourResetAt = new Date(item.nextResetTime);
            }
          } else if (item.unit === 6) {
            // unit=6 → 每周额度
            sevenDayPercent = item.percentage;
            if (item.nextResetTime) {
              sevenDayResetAt = new Date(item.nextResetTime);
            }
          }
        }
      }
    }

    // 钳位到0-100范围
    if (fiveHourPercent !== null) {
      fiveHourPercent = Math.max(0, Math.min(100, Math.round(fiveHourPercent)));
    }
    if (sevenDayPercent !== null) {
      sevenDayPercent = Math.max(0, Math.min(100, Math.round(sevenDayPercent)));
    }

    const result: UsageData = {
      planName: 'GLM',
      fiveHour: fiveHourPercent,
      sevenDay: sevenDayPercent,
      fiveHourResetAt,
      sevenDayResetAt,
    };

    // Write to file cache
    writeCache(homeDir, result, now);

    return result;
  } catch (error) {
    debug('getGlmUsage failed:', error);
    return null;
  }
}

/**
 * Read Claude Code settings from ~/.claude/settings.json
 */
function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      return null;
    }

    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings: ClaudeSettings = JSON.parse(content);
    return settings;
  } catch (error) {
    debug('Failed to read Claude settings:', error);
    return null;
  }
}

/**
 * 调用 GLM Coding Plan 配额查询接口。
 * 端点: https://api.z.ai/api/monitor/usage/quota/limit
 * 或:   https://open.bigmodel.cn/api/monitor/usage/quota/limit
 * 注意: Authorization header 直接使用 token，不加 "Bearer " 前缀。
 */
function fetchGlmQuotaApi(apiKey: string, baseUrl: string): Promise<GlmQuotaApiResponse['data'] | null> {
  return new Promise((resolve) => {
    let quotaHost: string;
    const parsedBaseUrl = new URL(baseUrl);

    if (baseUrl.includes('api.z.ai')) {
      quotaHost = 'api.z.ai';
    } else if (baseUrl.includes('open.bigmodel.cn') || baseUrl.includes('dev.bigmodel.cn')) {
      quotaHost = parsedBaseUrl.hostname;
    } else {
      debug('Unrecognized base URL for quota API:', baseUrl);
      resolve(null);
      return;
    }

    const options = {
      hostname: quotaHost,
      port: 443,
      path: '/api/monitor/usage/quota/limit',
      method: 'GET',
      headers: {
        'Authorization': apiKey,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-hud-glm/1.0',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res: any) => {
      let data = '';

      res.on('data', (chunk: any) => {
        data += chunk.toString();
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          debug('GLM quota API returned non-200 status:', res.statusCode);
          resolve(null);
          return;
        }

        try {
          const parsed: GlmQuotaApiResponse = JSON.parse(data);
          resolve(parsed.data ?? null);
        } catch (error: any) {
          debug('Failed to parse GLM quota API response:', error);
          resolve(null);
        }
      });
    });

    req.on('error', (error: any) => {
      debug('GLM quota API request error:', error);
      resolve(null);
    });

    req.on('timeout', () => {
      debug('GLM quota API request timeout');
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

// Export for testing
export function clearGlmCache(homeDir?: string): void {
  if (homeDir) {
    try {
      const cachePath = getCachePath(homeDir);
      if (fs.existsSync(cachePath)) {
        fs.unlinkSync(cachePath);
      }
    } catch {
      // Ignore
    }
  }
}
