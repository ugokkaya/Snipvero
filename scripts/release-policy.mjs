export function requireAccepted(receipt) {
  if (!receipt.id || receipt.status !== "Accepted") {
    throw new Error(
      `Notarization blocked: ${receipt.status ?? "unknown"} (${receipt.id ?? "no ID"})`,
    );
  }
  return receipt.id;
}

export function requireSigningConfig(identity, teamId, profile) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Invalid APPLE_TEAM_ID");
  if (!identity?.startsWith("Developer ID Application:") || !identity.endsWith(`(${teamId})`)) {
    throw new Error("APPLE_SIGNING_IDENTITY must be Developer ID Application for APPLE_TEAM_ID");
  }
  if (!profile?.trim()) throw new Error("NOTARY_KEYCHAIN_PROFILE is required");
}

export function caskFor(version, sha256) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid version");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  return `cask "snipvero" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/ugokkaya/Snipvero/releases/download/v#{version}/Snipvero_#{version}_aarch64.dmg"
  name "Snipvero"
  desc "Screenshot and annotation tool"
  homepage "https://snipvero.app"

  livecheck do
    skip "Beta channel: updated after a verified release"
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Snipvero.app"
end
`;
}
