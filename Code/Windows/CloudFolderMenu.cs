using System.Drawing.Drawing2D;

namespace MiniAppRuntime.Windows;

internal sealed class CloudFolderMenu : ContextMenuStrip
{
    private static readonly Color Surface = Color.FromArgb(0x18, 0x1f, 0x2b);
    private static readonly Color Hover = Color.FromArgb(0x22, 0x2d, 0x3c);
    private static readonly Color Outline = Color.FromArgb(0x34, 0x43, 0x5a);
    private static readonly Color TextColor = Color.FromArgb(0xed, 0xf4, 0xff);
    private static readonly Color Accent = Color.FromArgb(0x9e, 0xe5, 0xd1);
    private static readonly Color Disabled = Color.FromArgb(0x80, 0x90, 0xa5);
    private readonly Font menuFont = new("Segoe UI", 10f);
    private readonly List<Bitmap> icons = [];
    private readonly int cornerRadius;
    private readonly ToolStripMenuItem? views;
    private readonly ToolStripMenuItem? sorts;
    private readonly ToolStripMenuItem? transfers;

    private CloudFolderMenu(int dpi)
    {
        int Scale(int value) => (value * dpi + 48) / 96;

        cornerRadius = Scale(10);
        BackColor = Surface;
        ForeColor = TextColor;
        Font = menuFont;
        Renderer = CreateRenderer(dpi);
        DropShadowEnabled = true;
        ImageScalingSize = new Size(Scale(26), Scale(26));
    }

    public CloudFolderMenu(int dpi, bool hasChannel, string? view, string? sort, Action<string> execute) : this(dpi)
    {
        if (view is not null)
        {
            transfers = AddCommand("transfers", "Передача", MenuIcon.Transfers, true, execute);
            transfers.Available = false;
        }
        AddCommand("download-folder", "Скачать папку", MenuIcon.Download, hasChannel, execute);
        AddCommand("upload-files", "Загрузить файлы", MenuIcon.File, hasChannel, execute);
        AddCommand("upload-folder", "Загрузить папку", MenuIcon.Upload, hasChannel, execute);
        if (view is not null) AddCommand("create-folder", "Создать папку", MenuIcon.Create, hasChannel, execute);
        Items.Add(new ToolStripSeparator());
        AddCommand("choose-channel", "Выбрать канал", MenuIcon.Channel, true, execute);
        if (view is not null && sort is not null)
        {
            Items.Add(new ToolStripSeparator());
            views = AddChoices("view", "Вид", MenuIcon.View,
                [("tiles", "Плитки"), ("large", "Крупные плитки"), ("list", "Список")]);
            sorts = AddChoices("sort", "Сортировка", MenuIcon.Sort,
                [("name", "Имя А–Я"), ("name-desc", "Имя Я–А"), ("date", "Сначала новые"),
                    ("date-asc", "Сначала старые"), ("size", "Сначала большие"), ("size-asc", "Сначала маленькие")]);
            SetCatalogOptions(view, sort);
        }

        ToolStripMenuItem AddChoices(string id, string label, MenuIcon icon, (string Value, string Label)[] choices)
        {
            var item = AddItem(id, label, icon, hasChannel);
            var dropdown = (ToolStripDropDownMenu)item.DropDown;
            dropdown.BackColor = Surface;
            dropdown.Font = menuFont;
            dropdown.Renderer = Renderer;
            dropdown.ShowCheckMargin = true;
            dropdown.ShowImageMargin = false;
            foreach (var (value, text) in choices)
            {
                var choice = new ToolStripMenuItem(text) { Name = value };
                choice.Click += (_, _) => execute(id + ":" + value);
                item.DropDownItems.Add(choice);
            }
            return item;
        }

    }

    internal static CloudFolderMenu CreateFileMenu(int dpi, bool multiple, bool canShare, bool canDownload, Action<string> execute)
    {
        var menu = new CloudFolderMenu(dpi);
        if (!multiple) menu.AddCommand("files:rename", "Переименовать", MenuIcon.Rename, true, execute);
        menu.AddCommand("files:move", "Переместить", MenuIcon.Move, true, execute);
        menu.AddCommand("files:delete", "Удалить", MenuIcon.Delete, true, execute);
        menu.AddCommand("files:share", "Поделиться", MenuIcon.Share, canShare, execute);
        if (multiple) menu.AddCommand("files:download", "Скачать", MenuIcon.Download, canDownload, execute);
        return menu;
    }

    private ToolStripMenuItem AddCommand(string id, string label, MenuIcon icon, bool enabled, Action<string> execute)
    {
        var item = AddItem(id, label, icon, enabled);
        item.Click += (_, _) => execute(id);
        return item;
    }

    private ToolStripMenuItem AddItem(string id, string label, MenuIcon icon, bool enabled)
    {
        var image = DrawIcon(icon, enabled ? Accent : Disabled);
        icons.Add(image);
        var item = new ToolStripMenuItem(label, image) { Name = id, Enabled = enabled };
        Items.Add(item);
        return item;
    }

    internal static ToolStripRenderer CreateRenderer(int dpi) => new MenuRenderer((10 * dpi + 48) / 96, (5 * dpi + 48) / 96);

    public void SetTransfersAvailable(bool available)
    {
        if (transfers is not null) transfers.Available = available;
    }

    public void SetCatalogOptions(string? view, string? sort)
    {
        if (views is not null)
            foreach (ToolStripMenuItem choice in views.DropDownItems) choice.Checked = choice.Name == view;
        if (sorts is not null)
            foreach (ToolStripMenuItem choice in sorts.DropDownItems) choice.Checked = choice.Name == sort;
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (cornerRadius == 0 || Width < 2 || Height < 2) return;
        using var path = TopBarButton.RoundedPath(ClientRectangle, Math.Min(cornerRadius, Math.Min(Width, Height) / 2));
        Region = new Region(path);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (!disposing) return;
        foreach (var icon in icons) icon.Dispose();
        icons.Clear();
        menuFont.Dispose();
    }

    private enum MenuIcon { Transfers, Download, File, Upload, Create, Channel, View, Sort, Rename, Move, Delete, Share }

    private static Bitmap DrawIcon(MenuIcon icon, Color color)
    {
        var image = new Bitmap(48, 48);
        using var graphics = Graphics.FromImage(image);
        using var pen = new Pen(color, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.ScaleTransform(2, 2);

        void Stroke(params Point[] points) => graphics.DrawLines(pen, points);

        switch (icon)
        {
            case MenuIcon.Transfers:
                Stroke(new(8, 20), new(8, 4));
                Stroke(new(4, 8), new(8, 4), new(12, 8));
                Stroke(new(16, 4), new(16, 20));
                Stroke(new(12, 16), new(16, 20), new(20, 16));
                break;
            case MenuIcon.Download:
            case MenuIcon.Upload:
            case MenuIcon.Create:
                Stroke(new(4, 19), new(4, 5), new(9, 5), new(11, 7), new(20, 7), new(20, 19), new(4, 19));
                if (icon == MenuIcon.Create)
                {
                    Stroke(new(12, 10), new(12, 16));
                    Stroke(new(9, 13), new(15, 13));
                }
                else if (icon == MenuIcon.Download)
                {
                    Stroke(new(12, 10), new(12, 16));
                    Stroke(new(9, 13), new(12, 16), new(15, 13));
                }
                else
                {
                    Stroke(new(12, 16), new(12, 10));
                    Stroke(new(9, 13), new(12, 10), new(15, 13));
                }
                break;
            case MenuIcon.File:
                Stroke(new(6, 3), new(14, 3), new(19, 8), new(19, 21), new(6, 21), new(6, 3));
                Stroke(new(14, 3), new(14, 8), new(19, 8));
                Stroke(new(12, 18), new(12, 11));
                Stroke(new(9, 14), new(12, 11), new(15, 14));
                break;
            case MenuIcon.Channel:
                Stroke(new(4, 10), new(9, 10), new(19, 5), new(19, 18), new(9, 14), new(4, 14), new(4, 10));
                Stroke(new(6, 14), new(8, 20), new(11, 20), new(9, 14));
                break;
            case MenuIcon.View:
                graphics.DrawRectangles(pen, new Rectangle[] { new(4, 4, 6, 6), new(14, 4, 6, 6), new(4, 14, 6, 6), new(14, 14, 6, 6) });
                break;
            case MenuIcon.Sort:
                Stroke(new(5, 5), new(18, 5));
                Stroke(new(5, 10), new(15, 10));
                Stroke(new(5, 15), new(12, 15));
                Stroke(new(18, 14), new(18, 20));
                Stroke(new(15, 17), new(18, 20), new(21, 17));
                break;
            case MenuIcon.Rename:
                Stroke(new(5, 19), new(6, 14), new(16, 4), new(20, 8), new(10, 18), new(5, 19));
                Stroke(new(14, 6), new(18, 10));
                break;
            case MenuIcon.Move:
                Stroke(new(4, 9), new(4, 5), new(9, 5), new(11, 7), new(20, 7), new(20, 11));
                Stroke(new(4, 15), new(4, 19), new(20, 19));
                Stroke(new(7, 13), new(17, 13));
                Stroke(new(14, 10), new(17, 13), new(14, 16));
                break;
            case MenuIcon.Delete:
                Stroke(new(4, 7), new(20, 7));
                Stroke(new(9, 7), new(9, 4), new(15, 4), new(15, 7));
                Stroke(new(6, 7), new(7, 20), new(17, 20), new(18, 7));
                Stroke(new(10, 10), new(10, 16));
                Stroke(new(14, 10), new(14, 16));
                break;
            case MenuIcon.Share:
                Stroke(new(5, 18), new(6, 13), new(9, 10), new(14, 10), new(14, 5), new(20, 12),
                    new(14, 18), new(14, 14), new(10, 14), new(5, 18));
                break;
        }
        return image;
    }

    private sealed class MenuRenderer(int radius, int inset) : ToolStripRenderer
    {
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            using var fill = new SolidBrush(e.ToolStrip is ToolStripDropDown ? Surface : e.ToolStrip.BackColor);
            e.Graphics.FillRectangle(fill, e.AffectedBounds);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var size = e.ToolStrip.ClientSize;
            if (e.ToolStrip is not ToolStripDropDown || size.Width < 2 || size.Height < 2) return;
            using var path = TopBarButton.RoundedPath(new Rectangle(0, 0, size.Width - 1, size.Height - 1), radius);
            using var pen = new Pen(Outline);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.DrawPath(pen, path);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (e.Item.Enabled && e.Item.Selected) DrawHighlight(e);
        }

        protected override void OnRenderButtonBackground(ToolStripItemRenderEventArgs e)
        {
            if (e.Item.Selected || e.Item is ToolStripButton { Checked: true }) DrawHighlight(e);
        }

        protected override void OnRenderOverflowButtonBackground(ToolStripItemRenderEventArgs e)
        {
            if (e.Item.Selected || e.Item.Pressed) DrawHighlight(e);
            var center = new Point(e.Item.Width / 2, e.Item.Height / 2);
            using var pen = new Pen(TextColor, 1.5f);
            e.Graphics.DrawLines(pen, new Point[] { new(center.X - 3, center.Y - 1), new(center.X, center.Y + 2), new(center.X + 3, center.Y - 1) });
        }

        private void DrawHighlight(ToolStripItemRenderEventArgs e)
        {
            var bounds = new Rectangle(Point.Empty, e.Item.Size);
            bounds.Inflate(-inset, -1);
            if (bounds.Width < 2 || bounds.Height < 2) return;
            using var path = TopBarButton.RoundedPath(bounds, inset);
            using var fill = new SolidBrush(Hover);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.FillPath(fill, path);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? (e.Item.Owner is ToolStripDropDown ? TextColor : e.Item.ForeColor) : Disabled;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = e.Item?.Enabled == false ? Disabled : Accent;
            base.OnRenderArrow(e);
        }

        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var area = e.ImageRectangle;
            var center = new Point(area.Left + area.Width / 2, area.Top + area.Height / 2);
            using var pen = new Pen(Accent, 1.5f);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.DrawLines(pen, new Point[] { new(center.X - 4, center.Y), new(center.X - 1, center.Y + 3), new(center.X + 4, center.Y - 3) });
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using var pen = new Pen(Outline);
            int y = e.Item.Height / 2;
            e.Graphics.DrawLine(pen, inset * 2, y, e.Item.Width - inset * 2, y);
        }
    }
}
