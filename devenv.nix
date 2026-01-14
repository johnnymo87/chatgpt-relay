{ pkgs, ... }:

let
  pwBrowsers = pkgs.playwright-driver.browsers;

  # Read the chromium revision from playwright-driver's browsers.json
  browsersJson = builtins.fromJSON (builtins.readFile "${pkgs.playwright-driver}/browsers.json");
  chromiumEntry = builtins.head (builtins.filter (b: b.name == "chromium") browsersJson.browsers);
  chromiumRev = chromiumEntry.revision;

  # Construct path to chromium executable
  # On ARM64 Linux: chromium-XXXX/chrome-linux/chrome
  chromiumExe = "${pwBrowsers}/chromium-${chromiumRev}/chrome-linux/chrome";
in
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
  };

  # Python needed for node-gyp (Playwright has native deps)
  packages = [ pkgs.python3 ];

  env = {
    # Make Playwright look in the Nix store instead of ~/.cache/ms-playwright
    PLAYWRIGHT_BROWSERS_PATH = "${pwBrowsers}";

    # Don't let npm install auto-download browsers
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

    # Skip host validation on NixOS
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

    # Direct path to Nix-provided Chromium executable
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = chromiumExe;
  };

  dotenv.enable = true;

  enterShell = ''
    echo "chatgpt-relay - Node $(node --version)"
    echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
    echo "Chromium: $PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
  '';
}
