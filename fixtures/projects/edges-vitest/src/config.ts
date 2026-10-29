export function apiUrl(): string {
  return process.env.API_URL ?? "none";
}

export function featureOn(): boolean {
  return process.env.FEATURE === "1";
}
