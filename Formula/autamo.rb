class Autamo < Formula
  desc "Autamo - A Node.js application for git operations"
  homepage "https://autamo.ai"
  version "0.77.4"
  url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.77.4/autamo-arm64"
  sha256 "0a79d363179532168d46ab3463ddb7c4eef8b67ffc9cbd0727bb282454f359e8"
  license "MIT"

  on_arm do
    url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.77.4/autamo-arm64"
    sha256 "0a79d363179532168d46ab3463ddb7c4eef8b67ffc9cbd0727bb282454f359e8"
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
