#!/usr/bin/env bun
import { runMain } from "citty";
import { mainCommand } from "./cli/cli.ts";

void runMain(mainCommand);
