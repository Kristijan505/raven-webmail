import toml from "toml"
import { readFileSync } from "fs";
import pc from "picocolors";
import path from "path";
import { z } from "zod";

const BaseConfigSchema = z.object({
  port: z.number().int().positive(),
  base_url: z.string().optional(),
  secret_token: z.string()
    .min(32, "secret_token must be at least 32 characters; generate one with `openssl rand -hex 32`")
    // A copied config.sample.toml ships a >=32-char placeholder, so the length check
    // alone would accept it and the app would boot with a publicly known session
    // signing secret (anyone could forge/tamper session cookies). Reject the
    // placeholder outright so a copied sample fails loudly instead of silently.
    .refine((v) => !/CHANGE_ME/i.test(v), "secret_token is still the config.sample placeholder; generate a real one with `openssl rand -hex 32`"),
  wildduck_api_url: z.string().min(1),
  wildduck_api_token: z.string().min(1),
  mongodb_url: z.string().min(1),
  compression: z.boolean().nullable().optional(),
  trust_proxy: z.union([z.boolean(), z.number()]).optional(),
  json_body_limit: z.union([z.string(), z.number()]).optional(),
  session_name: z.string().optional(),
  session_resave: z.boolean().optional(),
  session_rolling: z.boolean().optional(),
  session_cookie_secure: z.boolean().optional(),
  session_cookie_http_only: z.boolean().optional(),
  session_cookie_same_site: z.enum(["lax", "strict", "none"]).optional(),
  session_cookie_domain: z.string().optional(),
  session_cookie_max_age_ms: z.number().int().positive().optional(),
  extra_locales_dirs: z.array(z.string()).optional(),
});

const ConfigSchema = z.union([
  BaseConfigSchema.extend({
    ssl: z.literal(false),
  }),
  BaseConfigSchema.extend({
    ssl: z.literal(true),
    ssl_certificate: z.string().min(1),
    ssl_certificate_key: z.string().min(1),
  }),
]);

export type Config = z.infer<typeof ConfigSchema>;

export const load = (filename: string): Config => {
  console.log("> loading config from", pc.yellow(filename));
  try {
    const source = readFileSync(filename, "utf8");
    const config = ConfigSchema.parse(toml.parse(source));
    if (config.extra_locales_dirs) {
      config.extra_locales_dirs = config.extra_locales_dirs.map(f => {
        return path.resolve(path.dirname(filename), f);
      })
    }

    return config;

  } catch(e: any) {
    console.error(pc.red("Error loading config file: " + e.message))
    process.exit(1);
  }
}
