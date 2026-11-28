import ExpoModulesCore
import UIKit

public final class BuzzGlassModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BuzzGlass")
    View(BuzzGlassSurface.self) {}
  }
}

final class BuzzGlassSurface: ExpoView {
  private let glass: UIVisualEffectView

  required init(appContext: AppContext? = nil) {
    #if compiler(>=6.2)
    if #available(iOS 26, *) {
      glass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    } else {
      glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    }
    #else
    glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    #endif
    super.init(appContext: appContext)
    glass.isUserInteractionEnabled = false
    glass.clipsToBounds = true
    addSubview(glass)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    glass.frame = bounds
    glass.layer.cornerRadius = bounds.height / 2
  }
}
