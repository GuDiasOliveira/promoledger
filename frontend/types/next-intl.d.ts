import type enUS from "@/messages/en-US.json";
import type { Locale } from "@/lib/i18n/config";

// en-US is the source of truth: unknown keys fail type-checking, and the parity test
// guarantees every other locale has exactly the same keys.
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof enUS;
  }
}
