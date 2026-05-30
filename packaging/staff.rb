class Staff < Formula
  desc "Staff Review — a local code review tool with AI-coding-agent skills"
  homepage "https://github.com/staffreview/staffreview"
  version "0.1.0"
  license "Apache-2.0"

  if OS.mac?
    if Hardware::CPU.arm?
      url "https://github.com/staffreview/staffreview/releases/download/v#{version}/staff-darwin-arm64"
      sha256 "2b142509d28e0d9aa0b33086c11cc826de4435f702663b1a847d5e66a7f2f6f0"
    else
      url "https://github.com/staffreview/staffreview/releases/download/v#{version}/staff-darwin-x64"
      sha256 "9ff41c398aa78d43e0abc47d4808500be9460c2ed37b60cb05bda588c2aec69b"
    end
  elsif OS.linux?
    if Hardware::CPU.arm?
      url "https://github.com/staffreview/staffreview/releases/download/v#{version}/staff-linux-arm64"
      sha256 "3e41ca2cee71aded50227e6f491d01fe674be002282d6dca7448391c47e064aa"
    else
      url "https://github.com/staffreview/staffreview/releases/download/v#{version}/staff-linux-x64"
      sha256 "d81b2e4d277760da02a0fb01d1190b12a34536aad8ae765f2dc92eb00cc68082"
    end
  end

  def install
    binary_name = "staff-#{OS.mac? ? "darwin" : "linux"}-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
    bin.install binary_name => "staff"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/staff --version")
  end
end
