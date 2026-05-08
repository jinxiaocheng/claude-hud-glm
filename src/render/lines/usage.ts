import type { RenderContext } from '../../types.js';
import { isLimitReached } from '../../types.js';
import { red, yellow, dim, getContextColor, RESET } from '../colors.js';

export function renderUsageLine(ctx: RenderContext): string | null {
  const display = ctx.config?.display;

  if (display?.showUsage === false) {
    return null;
  }

  if (!ctx.usageData?.planName) {
    return null;
  }

  if (ctx.usageData.apiUnavailable) {
    return yellow(`usage: ⚠`);
  }

  if (isLimitReached(ctx.usageData)) {
    const resetTime = ctx.usageData.fiveHour === 100
      ? formatResetTime(ctx.usageData.fiveHourResetAt)
      : formatResetTime(ctx.usageData.sevenDayResetAt);
    return red(`⚠ Limit reached${resetTime ? ` (resets ${resetTime})` : ''}`);
  }

  // GLM Coding Plan: 显示5小时和每周token用量
  if (ctx.usageData.planName === 'GLM') {
    const fiveHour = ctx.usageData.fiveHour;
    const sevenDay = ctx.usageData.sevenDay;
    const fiveHourReset = formatResetTime(ctx.usageData.fiveHourResetAt);
    const sevenDayReset = formatResetTime(ctx.usageData.sevenDayResetAt);

    // 同时显示5h和每周用量
    if (fiveHour !== null && sevenDay !== null) {
      const fiveHourDisplay = formatUsagePercent(fiveHour);
      const sevenDayDisplay = formatUsagePercent(sevenDay);
      const fivePart = fiveHourReset
        ? `5h: ${fiveHourDisplay} (${fiveHourReset})`
        : `5h: ${fiveHourDisplay}`;
      return `${fivePart} | 7d: ${sevenDayDisplay}`;
    }

    if (fiveHour !== null) {
      const fiveHourDisplay = formatUsagePercent(fiveHour);
      return fiveHourReset
        ? `5h: ${fiveHourDisplay} (${fiveHourReset})`
        : `5h: ${fiveHourDisplay}`;
    }

    if (sevenDay !== null) {
      const sevenDayDisplay = formatUsagePercent(sevenDay);
      return sevenDayReset
        ? `7d: ${sevenDayDisplay} (${sevenDayReset})`
        : `7d: ${sevenDayDisplay}`;
    }

    return null;
  }

  // Standard Anthropic display with 5h and 7d windows
  const threshold = display?.usageThreshold ?? 0;
  const fiveHour = ctx.usageData.fiveHour;
  const sevenDay = ctx.usageData.sevenDay;

  const effectiveUsage = Math.max(fiveHour ?? 0, sevenDay ?? 0);
  if (effectiveUsage < threshold) {
    return null;
  }

  const fiveHourDisplay = formatUsagePercent(ctx.usageData.fiveHour);
  const fiveHourReset = formatResetTime(ctx.usageData.fiveHourResetAt);
  const fiveHourPart = fiveHourReset
    ? `5h: ${fiveHourDisplay} (${fiveHourReset})`
    : `5h: ${fiveHourDisplay}`;

  if (sevenDay !== null && sevenDay >= 80) {
    const sevenDayDisplay = formatUsagePercent(sevenDay);
    return `${fiveHourPart} | 7d: ${sevenDayDisplay}`;
  }

  return fiveHourPart;
}

function formatUsagePercent(percent: number | null): string {
  if (percent === null) {
    return dim('--');
  }
  const color = getContextColor(percent);
  return `${color}${percent}%${RESET}`;
}

function formatResetTime(resetAt: Date | null): string {
  if (!resetAt) return '';
  const now = new Date();
  const diffMs = resetAt.getTime() - now.getTime();
  if (diffMs <= 0) return '';

  const diffMins = Math.ceil(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
