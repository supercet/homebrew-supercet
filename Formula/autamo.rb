class Autamo < Formula
  desc "Autamo - A Node.js application for git operations"
  homepage "https://autamo.ai"
  version "0.77.3"
  url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.77.3/autamo-arm64"
  sha256 "6d72b5b2154e2767f0fb639ac632b64ceb759354dbd24e5c91df72d717565669"
  license "MIT"

  on_arm do
    url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.77.3/autamo-arm64"
    sha256 "6d72b5b2154e2767f0fb639ac632b64ceb759354dbd24e5c91df72d717565669"
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
    url :stable
    strategy :github_latest
  end

  test do
    # Test that the binary exists and is executable
    assert_predicate bin/"autamo", :exist?
    assert_predicate bin/"autamo", :executable?

    # Test that the command runs (even if it fails, it should not crash)
    system "#{bin}/autamo", "--help"
  end
end
