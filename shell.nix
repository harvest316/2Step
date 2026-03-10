{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  name = "2step";

  buildInputs = with pkgs; [
    nodejs_22
    nodePackages.npm
    sqlite
    gcc
    gnumake
    pkg-config
    claude-code
    git
    gh
  ];

  shellHook = ''
    echo "2Step Video Review Outreach"
    echo ""
    echo "Node: $(node --version) | sqlite3: $(sqlite3 --version | cut -d' ' -f1)"
    echo ""

    export PATH="$PWD/node_modules/.bin:$PATH"

    if [ ! -d "node_modules" ]; then
      echo "Installing npm dependencies..."
      npm install
      echo ""
    fi

    echo "Commands:"
    echo "  npm run prospect -- --query \"pest control\" --location \"Sydney, NSW\""
    echo "  npm run video:prompts"
    echo "  npm run outreach:dm"
    echo "  npm run outreach:email"
    echo "  npm run sheets:push"
    echo ""
  '';

  NIX_LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
    pkgs.stdenv.cc.cc
    pkgs.stdenv.cc.cc.lib
  ];

  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [
    pkgs.stdenv.cc.cc.lib
  ];
}
