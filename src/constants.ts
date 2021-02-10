/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from "vscode";
import * as path from "path";
import { Context } from "./context";

export const imagesPath = "images";
export const INPUT_TITLE = 'Kafka Tools';

type DarkLightPath = { light: string; dark: string};

const getDarkLightPath = (fileName: string): DarkLightPath => {
    return {
        light: Context.current.asAbsolutePath(path.join(imagesPath, "light", fileName)),
        dark: Context.current.asAbsolutePath(path.join(imagesPath, "dark", fileName)),
    };
};

const getIconPath = (fileName: string): string => {
    return Context.current.asAbsolutePath(path.join(imagesPath, fileName));
};

export class Icons {
    public static get Kafka(): DarkLightPath {
        return getDarkLightPath("kafka.svg");
    }

    public static get Server(): DarkLightPath {
        return getDarkLightPath("server.svg");
    }

    public static get Topic(): DarkLightPath {
        return getDarkLightPath("topic.svg");
    }

    public static get Group(): DarkLightPath {
        return getDarkLightPath("group.svg");
    }

    public static get Trash(): DarkLightPath {
        return getDarkLightPath("trashcan.svg");
    }

    public static get Warning(): string {
        return getIconPath("warning.svg");
    }

    public static get Information(): DarkLightPath {
        return getDarkLightPath("information.svg");
    }
}


export enum GlyphChars {
    Check = '\u2713'
}

export class CommonMessages {
    public static showNoSelectedCluster(): void {
        vscode.window.showInformationMessage("No cluster selected");
    }

    public static showUnhandledError(...items: string[]): void {
        vscode.window.showErrorMessage("Unexpected error happened", ...items);
    }
}
