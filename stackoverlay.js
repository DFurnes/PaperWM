const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Tiling = Extension.imports.tiling;
const Clutter = imports.gi.Clutter;
const Tweener = imports.ui.tweener;
const Lang = imports.lang;
const Main = imports.ui.main;
const Shell = imports.gi.Shell;
const utils = Extension.imports.utils;
const debug = utils.debug;
const Minimap = Extension.imports.minimap;

/*
  The stack overlay decorates the top stacked window with its icon and
  captures mouse input such that a mouse click only _activates_ the
  window. A very limited portion of the window is visible and due to
  the animation the button-up event will be triggered at an
  unpredictable position

  See #10
*/

/*
  Parent of the overlay?

  Most natural parent is the window actor, but then the overlay
  becomes visible in the clones too.

  Since the stacked windows doesn't really move it's not a big problem
  that the overlay doesn't track the window. The main challenge with
  using a different parent becomes controlling the "z-index".

  If I understand clutter correctly that can only be done by managing
  the order of the scene graph nodes. Descendants of node A will thus
  always be drawn in the same plane compared to a non-descendants.

  The overlay thus have to be parented to `global.window_group`. One
  would think that was ok, but unfortunately mutter keeps syncing the
  window_group with the window stacking and in the process destroy the
  stacking of any non-window actors.

  Adding a "clutter restack" to the `MetaScreen` `restacked` signal
  seems keep the stacking in sync (without entering into infinite
  restack loops)
*/

function createAppIcon(metaWindow, size) {
    let tracker = Shell.WindowTracker.get_default();
    let app = tracker.get_window_app(metaWindow);
    let appIcon = app ? app.create_icon_texture(size)
        : new St.Icon({ icon_name: 'icon-missing',
                        icon_size: size });
    appIcon.x_expand = appIcon.y_expand = true;
    appIcon.x_align = appIcon.y_align = Clutter.ActorAlign.END;

    return appIcon;
}

var StackOverlay = new Lang.Class({
    Name: 'Stackoverlay',

    _init: function(showIcon) {
        this.showIcon = showIcon;

        let overlay = new Clutter.Actor({ reactive: true
                                          , name: "stack-overlay" });

        this.monitor = Main.layoutManager.primaryMonitor;

        let panelBox = Main.layoutManager.panelBox;

        overlay.y = panelBox.height;
        // global.window_group is below the panel so not really necessary to adjust height?
        overlay.height = this.monitor.height - panelBox.height; 
        overlay.width = Tiling.stack_margin;

        overlay.hide();

        this.pressId = overlay.connect('button-press-event', () => {
            return true;
        });
        this.releaseId = overlay.connect('button-release-event', () => {
            // this.fadeOut();
            Main.activateWindow(this.target);
            return true;
        });

        global.window_group.add_child(overlay);
        Main.layoutManager._trackActor(overlay)

        this.overlay = overlay;

        // We must "restack" the overlay each time mutter does a window restack
        // :(
        // NOTE: Should probably use _one_ callback for all non-window actors we
        // need to keep stacked in window_group, but this works for now
        this.restackId = global.screen.connect("restacked", () => {
            if (!this.target)
                return;
            let actor = this.target.get_compositor_private();
            global.window_group.set_child_above_sibling(this.overlay,
                                                        actor);
        });
    },
    updateIcon: function() {
        if (this.icon) {
            this.icon.destroy();
            this.icon = null;
        }

        let iconMarginX = 2;
        let iconSize = margin_lr;
        let icon = createAppIcon(this.target, iconSize);
        this.icon = icon;

        let actor = this.target.get_compositor_private();

        if (actor.x <= Tiling.stack_margin) {
            icon.x = iconMarginX;
        } else {
            icon.x = this.overlay.width - iconMarginX - iconSize; 
        }

        let [dx, dy] = Minimap.calcOffset(this.target);
        icon.y = actor.y + dy + 4 - this.overlay.y;

        this.overlay.add_child(icon);
    },
    setTarget: function(metaWindow) {
        this.target = metaWindow;

        let bail = () => {
            this.target = null;
            this.overlay.hide();
            return false;
        }

        if (!metaWindow) {
            // No target. Eg. if we're at the left- or right-most window
            return bail();
        }

        let overlay = this.overlay;
        let actor = metaWindow.get_compositor_private();
        let frame = metaWindow.get_frame_rect();
        let resizeBorderWidth = 5; // approx.
        let space = Tiling.spaces.spaceOfWindow(metaWindow);


        // Note: Atm. this can be called when the windows are moving. Therefore
        //       we must use destinationX and we might occationally get wrong y
        //       positions (icon) (since we don't track the y destination)
        //       We also assume window widths are are unchanging.
        if (actor.x < Tiling.stack_margin) {
            let neighbour = space[space.indexOf(metaWindow) + 1]
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!
 
            let neighbourX = neighbour.destinationX ||
                neighbour.get_frame_rect().x;

            overlay.x = 0;
            overlay.width = Math.min(
                Tiling.stack_margin,
                Math.max(0, neighbourX - resizeBorderWidth)
            );
        } else {
            let neighbour = space[space.indexOf(metaWindow) - 1]
            if (!neighbour)
                return bail(); // Should normally have a neighbour. Bail!

            let neighbourFrame = neighbour.get_frame_rect();
            let neighbourX = neighbour.destinationX || neighbourFrame.x;
            
            overlay.x = Math.max(
                this.monitor.width - Tiling.stack_margin,
                neighbourX + neighbourFrame.width + resizeBorderWidth
            );
            overlay.width = this.monitor.width - overlay.x;
        }

        if (this.showIcon) {
            this.updateIcon();
        }

        global.window_group.set_child_above_sibling(overlay, actor);

        // Tweener.addTween(this.overlay, { opacity: 255, time: 0.25 });
        overlay.show();
        return true;
    },
    fadeOut: function() {
        Tweener.addTween(this.overlay, { opacity: 0, time: 0.25 });
    }
});

var leftOverlay;
var rightOverlay;
function enable() {
    leftOverlay  = new StackOverlay();
    rightOverlay = new StackOverlay();
}

function disable() {
    // Disconnect the overlay
    for (let overlay of [leftOverlay, rightOverlay]) {
        let actor = overlay.overlay;
        actor.disconnect(overlay.pressId);
        actor.disconnect(overlay.releaseId);
        global.screen.disconnect(overlay.restackId);
        actor.destroy();
    }
}
