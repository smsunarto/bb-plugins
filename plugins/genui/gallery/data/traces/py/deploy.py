import sys

from settings import SettingsError, read_settings, region

FALLBACK = "deploy.defaults.json"


def main(path):
    try:
        settings = read_settings(path)
    except SettingsError:
        settings = read_settings(FALLBACK)
    print(f"Deploying to {region(settings)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "deploy.json")
