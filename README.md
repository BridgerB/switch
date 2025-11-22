# switch

NixOS/nix-darwin rebuild automation tool

## Steps

1. Show git diff (excluding `.lock` files)
2. Show git status
3. Ask to stage files (if changes detected)
4. Run `nixos-rebuild switch` or `darwin-rebuild switch`
5. Get generation number
6. Show git status
7. Ask to commit changes
8. Ask to push changes
