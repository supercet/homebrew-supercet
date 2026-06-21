class Autamo < Formula
  desc "Autamo - A Node.js application for git operations"
  homepage "https://autamo.ai"
  version "0.74.1"
  url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.74.1/autamo-arm64"
  sha256 "588697826163945d9c1316863125cbeac3485a9257f59edcd2d2382277ef79b4"
  license "MIT"

  on_arm do
    url "https://github.com/tryautamo/homebrew-tap/releases/download/v0.74.1/autamo-arm64"
    sha256 "588697826163945d9c1316863125cbeac3485a9257f59edcd2d2382277ef79b4"
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
