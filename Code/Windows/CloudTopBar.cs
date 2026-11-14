namespace MiniAppRuntime.Windows;

internal sealed record CloudToolbarState(bool Connected, bool HasChannel, string ChannelTitle = "", string Folder = "",
    string? View = null, string? Sort = null, bool HasTransfers = false);

internal sealed class CloudTopBar : NativeTopBar
{
    private CloudToolbarState cloud = new(false, false);
    private CloudFolderMenu? cloudMenu;
    private CloudFolderMenu? fileMenu;
    private ToolStrip? cloudPath;

    public bool ShowCloudContextMenu(string kind, bool canShare, bool canDownload)
    {
        if (!Visible || cloudMenu is null || (kind != "background" && !cloud.HasChannel)) return false;
        fileMenu?.Dispose();
        fileMenu = null;
        if (kind == "background") cloudMenu.Show(Cursor.Position);
        else
        {
            fileMenu = CloudFolderMenu.CreateFileMenu(DeviceDpi, kind == "selection", canShare, canDownload,
                RaiseAction);
            fileMenu.Show(Cursor.Position);
        }
        return true;
    }

    public void SetCloudToolbar(CloudToolbarState state)
    {
        if (cloud == state) return;
        var previous = cloud;
        cloud = state;
        if (Configuration is not null && (previous.Connected != state.Connected ||
            previous.HasChannel != state.HasChannel || (previous.View is null) != (state.View is null)))
        {
            Apply(Configuration);
            return;
        }
        if (previous.ChannelTitle != state.ChannelTitle || previous.Folder != state.Folder) UpdateCloudPath();
        cloudMenu?.SetCatalogOptions(state.View, state.Sort);
        cloudMenu?.SetTransfersAvailable(state.HasTransfers);
    }

    protected override void ClearExtras()
    {
        cloudMenu?.Dispose();
        cloudMenu = null;
        fileMenu?.Dispose();
        fileMenu = null;
        cloudPath = null;
    }

    protected override void AddTitleExtras(TopBarConfiguration config, Label title)
    {
        if (cloud.Connected && cloud.HasChannel && cloud.View is not null)
        {
            cloudPath = new ToolStrip
            {
                Dock = DockStyle.Fill, AutoSize = false, GripStyle = ToolStripGripStyle.Hidden,
                LayoutStyle = ToolStripLayoutStyle.HorizontalStackWithOverflow, CanOverflow = true,
                BackColor = config.Background, ForeColor = config.Foreground, Padding = new Padding(10, 0, 0, 0),
                Renderer = CloudFolderMenu.CreateRenderer(DeviceDpi), AccessibleName = "Путь папки"
            };
            Controls.Add(cloudPath);
            title.Dock = DockStyle.Left;
            title.Width = TextRenderer.MeasureText(config.Title, title.Font).Width;
            UpdateCloudPath();
        }
    }

    protected override void AddActionExtras(TopBarConfiguration config)
    {
        if (cloud.Connected)
        {
            var menu = cloudMenu = new CloudFolderMenu(DeviceDpi, cloud.HasChannel, cloud.View, cloud.Sort,
                RaiseAction);
            menu.SetTransfersAvailable(cloud.HasTransfers);
            var style = config.BackButton with { Background = config.Background, Foreground = config.Foreground, FontSize = 16 };
            var button = CreateButton("⋮", style, config.Background, () => { });
            button.Dock = DockStyle.Right;
            button.AccessibleName = "Действия с папкой";
            button.ContextMenuStrip = menu;
            button.Click += (_, _) => menu.Show(button, new Point(button.Width, button.Height), ToolStripDropDownDirection.BelowLeft);
            Controls.Add(button);
        }
    }

    private void UpdateCloudPath()
    {
        var path = cloudPath;
        if (path is null) return;
        path.SuspendLayout();
        while (path.Items.Count > 0)
        {
            var item = path.Items[0];
            path.Items.RemoveAt(0);
            item.Dispose();
        }
        var parts = cloud.Folder.Length > 0 ? cloud.Folder.Split('/') : [];
        AddCrumb(cloud.ChannelTitle, "", parts.Length == 0, false);
        var current = "";
        for (var index = 0; index < parts.Length; index++)
        {
            current = index == 0 ? parts[index] : current + "/" + parts[index];
            AddCrumb(parts[index], current, index == parts.Length - 1, true);
        }
        path.ResumeLayout(true);

        void AddCrumb(string label, string folder, bool selected, bool nested)
        {
            var text = label.Length <= 24 ? label : label[..23] + "…";
            var crumb = new ToolStripButton((nested ? "›  " : "") + text)
            {
                AccessibleName = label, ToolTipText = label, Checked = selected,
                Padding = new Padding(5, 0, 5, 0),
                Overflow = selected ? ToolStripItemOverflow.Never : ToolStripItemOverflow.AsNeeded
            };
            crumb.Click += (_, _) => RaiseAction("folder:" + folder);
            path.Items.Add(crumb);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            cloudMenu?.Dispose();
            fileMenu?.Dispose();
        }
        base.Dispose(disposing);
    }

}
