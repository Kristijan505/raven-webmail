import { program as cmd } from "commander";
const pkg = require("../../package.json");

import pc from "picocolors";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import en from "./i18n/src/en";

import { promises } from "fs";
const { mkdir } = promises;

import * as config from "./config";

const createConfig = (opts: {output: string}) => {
  console.log("> Creating config file in " + pc.yellow(opts.output));
  const sample = path.resolve(__dirname, "../../config.sample.toml");
  const dest = path.resolve(process.cwd(), opts.output);
  if(fs.existsSync(dest)) {
    console.error(pc.red(`> Aborting: file ${dest} already exists`))
    return process.exit(1);
  }

  // Generate a strong random session secret instead of shipping the placeholder.
  const secret = crypto.randomBytes(32).toString("hex");
  const template = fs.readFileSync(sample, "utf8");
  const contents = template.replace(/^secret_token=.*$/m, `secret_token="${secret}"`);
  fs.writeFileSync(dest, contents);

  console.log("> Config file created in " + pc.yellow(dest));
  console.log("> A random secret_token was generated for you")
  console.log("> Before start edit the settings as needed")
  console.log("> Then run " + pc.yellow("raven start") + " in the config directory")
}

const start = async (opts: {config: string}) => {
  const conf = config.load(path.resolve(process.cwd(), opts.config));
  (await import("./server")).start(conf)
}

const createLocale = async (opts: {config: string, code: string}) => {

  if(opts.code == null) {
    console.error('--code="ISO_CODE" is required');
    process.exit(1);
  }

  const conf = config.load(path.resolve(process.cwd(), opts.config));
  if(conf.extra_locales_dirs == null || conf.extra_locales_dirs.length === 0) {
    console.error(pc.red(`> You must add a directory to ${pc.yellow("config.extra_locale_dirs")} before running this`))
    return process.exit(1);
  }

  const dir = conf.extra_locales_dirs[0];
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, opts.code + ".json");
  if(fs.existsSync(file)) {
    console.error(pc.red(`> Aborting: file ${pc.yellow(file)} already exists`))
    return process.exit(1);
  }

  fs.writeFileSync(file, JSON.stringify(en, null, 2));
  console.log("> locale file created into " + pc.yellow(file));
}

cmd.version(pkg.version);

cmd.command("create-config")
  .description("create the default config.toml file")
  .option("-o --output <path>", "path to ouput file", "./config.toml")
  .action(createConfig)

cmd.command("start")
  .description("starts the webmail server")
  .option("-c --config <path>", "path to the config file", "./config.toml")
  .action(start);

cmd.command("create-locale")
    .description("creates a default locale file into `config.extra_locale_dirs.0/code.json`")
    .option("-c --config <path>", "path to the config file", "./config.toml")
    .option("--code <code>", "locale ISO code")
    .action(createLocale)

cmd.parse(process.argv);
