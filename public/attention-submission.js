const FACT_REFRESH_WAIT_MS = 120_000;

export async function postAttentionDuringFactRefresh(
  url,
  options,
  {
    fetcher = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    isCurrent = () => true,
    onWaiting = () => {},
  } = {},
) {
  const deadline = now() + FACT_REFRESH_WAIT_MS;
  let attempts = 0;
  while (isCurrent()) {
    const response = await fetcher(url, options);
    if (response.status !== 503) return response;
    const body = await response.json().catch(() => null);
    if (body?.code !== "CONFIRMATION_FACTS_NOT_READY") return response;
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error("最新事实仍在核对，请稍后重试；你的答复已保留在页面中。");
    }
    onWaiting();
    attempts += 1;
    await sleep(Math.min(remaining, attempts * 2_000, 10_000));
  }
  return null;
}
