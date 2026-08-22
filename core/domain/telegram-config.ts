/**
 * Telegram settings as persisted in `telegram.json` - non-secret by
 * construction: the token is referenced (secret id + environment variable
 * NAME), never stored. The parser refuses a token-SHAPED value in either
 * reference field before it can reach a plaintext settings file; that
 * refusal is this module's whole reason to live in core, where both the
 * daemon and the backup restore path can share it.
 */

export interface DaemonTelegramConfig {
  readonly enabled: boolean;
  readonly tokenSecretId: string;
  readonly tokenEnvVar: string;
  readonly allowedUserIds: readonly number[];
  readonly defaultProviderProfileId: string;
  readonly defaultPersonaId: string;
  readonly defaultVariants: readonly string[];
}

export const TELEGRAM_DEFAULTS: DaemonTelegramConfig = {
  enabled: false,
  tokenSecretId: "telegram:bot",
  tokenEnvVar: "DELOS_TELEGRAM_BOT_TOKEN",
  allowedUserIds: [],
  defaultProviderProfileId: "",
  defaultPersonaId: "",
  defaultVariants: [],
};

/** Bot tokens look like `<digits>:<base64ish>`; a reference must not. */
const TELEGRAM_TOKEN_SHAPE = /\d{5,}:[A-Za-z0-9_-]{20,}/;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

export function parseTelegramConfig(input: unknown): DaemonTelegramConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  const str = (key: string, fallback: string): string =>
    typeof raw[key] === "string" ? (raw[key] as string) : fallback;
  const config: DaemonTelegramConfig = {
    enabled: raw["enabled"] === true,
    tokenSecretId: str("tokenSecretId", TELEGRAM_DEFAULTS.tokenSecretId),
    tokenEnvVar: str("tokenEnvVar", TELEGRAM_DEFAULTS.tokenEnvVar),
    allowedUserIds: Array.isArray(raw["allowedUserIds"])
      ? raw["allowedUserIds"].filter((v): v is number => Number.isInteger(v))
      : [],
    defaultProviderProfileId: str("defaultProviderProfileId", ""),
    defaultPersonaId: str("defaultPersonaId", ""),
    defaultVariants: Array.isArray(raw["defaultVariants"])
      ? raw["defaultVariants"].filter((v): v is string => typeof v === "string")
      : [],
  };
  for (const [field, value] of [
    ["tokenSecretId", config.tokenSecretId],
    ["tokenEnvVar", config.tokenEnvVar],
  ] as const) {
    if (TELEGRAM_TOKEN_SHAPE.test(value)) {
      // The one mistake this file must never absorb: a pasted token. Refuse
      // it before it can be persisted into a plaintext settings file.
      throw new TelegramConfigError(
        `${field} looks like a bot token. Configuration stores a reference; ` +
          `put the token in the ${config.tokenEnvVar} environment variable instead.`,
      );
    }
  }
  if (!ENV_VAR_NAME.test(config.tokenEnvVar)) {
    throw new TelegramConfigError("tokenEnvVar is not a usable environment variable name.");
  }
  return config;
}
