class Autamo < Formula
  desc "Autamo - A Node.js application for git operations"
  homepage "https://autamo.ai"
  version "0.82.2"
  url "https://tap.autamo.ai/0.82.2/autamo-arm64"
  sha256 "df308bec2572edf76a34a44ab4a17fc6364df2ac1387985ef695795a57580108"
  license "MIT"

  on_arm do
    url "https://tap.autamo.ai/0.82.2/autamo-arm64"
    sha256 "df308bec2572edf76a34a44ab4a17fc6364df2ac1387985ef695795a57580108"
  end

  # on_intel do
  #   url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.6.2/autamo-x64"
  #
  # end

  def install
    # Install the pre-compiled binary
    bin.install "autamo-#{Hardware::CPU.arm? ? "arm64" : "x64"}" => "autamo"
    chmod 0755, bin/"autamo"
  end

  livecheck do
    # The stable url points at Cloudflare R2 (tap.autamo.ai), so github_latest
    # can't derive the repo from it — point it at the GitHub repo explicitly.
    # Releases are tagged with the bare version (e.g. "0.77.4"); the optional "v"
    # keeps older v-prefixed tags working too.
    url "https://github.com/tryautamo/homebrew-tap"
    strategy :github_latest
    regex(/^v?(\d+(?:\.\d+)+)$/i)
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"autamo", :exist?
    assert_predicate bin/"autamo", :executable?

    # Test that the command runs (even if it fails, it should not crash)
    system "#{bin}/autamo", "--help"
  end
end
