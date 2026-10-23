import { addons } from "storybook/manager-api";
import "../plugins/monokai/themes/bb-monokai.css";
import { monokaiStorybookTheme } from "./monokai";

addons.setConfig({ theme: monokaiStorybookTheme() });
