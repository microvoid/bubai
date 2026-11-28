Pod::Spec.new do |s|
  s.name = 'BuzzGlass'
  s.version = '1.0.0'
  s.summary = 'Buzz navigation glass surface'
  s.description = s.summary
  s.author = 'Bubai'
  s.homepage = 'https://github.com/microvoid/bubai'
  s.license = 'MIT'
  s.source = { :git => s.homepage + '.git' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '*.swift'
  s.dependency 'ExpoModulesCore'
end
