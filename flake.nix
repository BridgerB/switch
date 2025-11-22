{
  description = "A custom switch script for managing NixOS/nix-darwin rebuilds";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      packages.default = pkgs.stdenv.mkDerivation {
        pname = "switch";
        version = "1.0.0";
        src = self;

        nativeBuildInputs = with pkgs; [
          deno
        ];

        buildPhase = ''
          # Skip caching - dependencies will be downloaded at runtime
          echo "Skipping build phase - Deno will cache dependencies on first run"
        '';

        installPhase = ''
          mkdir -p $out/bin $out/share/switch
          cp main.ts $out/share/switch/main.ts
          cat > $out/bin/switch << EOF
          #!/bin/sh
          export DENO_DIR="\''${DENO_DIR:-\$HOME/.cache/deno}"
          exec ${pkgs.deno}/bin/deno run --no-lock --allow-run --allow-read --allow-write --allow-env --allow-net $out/share/switch/main.ts "\$@"
          EOF
          chmod +x $out/bin/switch
        '';

        meta = with pkgs.lib; {
          description = "A custom switch binary for managing NixOS/nix-darwin rebuilds";
          homepage = "https://github.com/BridgerB/switch";
          license = licenses.mit;
          maintainers = [];
          mainProgram = "switch";
        };
      };

      devShells.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          deno
        ];
        shellHook = ''
          echo "Welcome to the switch development shell!"
          echo "Deno version: $(deno --version | head -n1)"
        '';
      };

      # Add apps output for user-friendly running
      apps = {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/switch";
        };
      };
    });
}
