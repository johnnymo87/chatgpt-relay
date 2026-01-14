{ pkgs, ... }:

let
  pwBrowsers = pkgs.playwright-driver.browsers;
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
  };

  dotenv.enable = true;

  enterShell = ''
    echo "chatgpt-relay - Node $(node --version)"
    echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
  '';
}
