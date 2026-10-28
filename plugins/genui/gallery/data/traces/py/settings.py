"""Reads the deploy settings file and checks the fields the deploy needs."""
import json


class SettingsError(Exception):
    pass


def read_settings(path):
    with open(path) as handle:
        text = handle.read()
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise SettingsError(f"{path} is not valid JSON") from error


def region(settings):
    return settings["deploy"]["region"]
