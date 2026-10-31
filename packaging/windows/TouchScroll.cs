using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Native single-finger pan works over child controls without turning a tap into a drag.
internal sealed class TouchScroll : IMessageFilter,IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct GestureConfig {public uint id,want,block;}
    [StructLayout(LayoutKind.Sequential)] struct SmallPoint {public short x,y;}
    [StructLayout(LayoutKind.Sequential)] struct GestureInfo {public uint size,flags,id;public IntPtr target;public SmallPoint position;public uint instance,sequence;public ulong arguments;public uint extra;}
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetGestureConfig(IntPtr window,uint reserved,uint count,ref GestureConfig config,uint size);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetGestureInfo(IntPtr handle,ref GestureInfo info);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseGestureInfoHandle(IntPtr handle);
    internal bool Configured {get;private set;}
    readonly Form root;Control target;int previousY,rowPixels;bool panning,disposed;
    public TouchScroll(Form root){this.root=root;root.Disposed+=RootDisposed;Watch(root);Application.AddMessageFilter(this);}
    void Watch(Control control){control.HandleCreated+=Configure;control.ControlAdded+=Added;foreach(Control child in control.Controls)Watch(child);if(control.IsHandleCreated)Configure(control,EventArgs.Empty);}
    void Added(object sender,ControlEventArgs e){Watch(e.Control);}
    void Configure(object sender,EventArgs e){if(Environment.OSVersion.Platform!=PlatformID.Win32NT)return;var control=(Control)sender;var config=new GestureConfig{id=4,want=1|2|8|16,block=4};bool configured=SetGestureConfig(control.Handle,0,1,ref config,(uint)Marshal.SizeOf(typeof(GestureConfig)));if(control==root)Configured=configured;}
    static Control AtPoint(Control root,Point screen){Control current=root;while(true){var child=current.GetChildAtPoint(current.PointToClient(screen),GetChildAtPointSkip.Invisible);if(child==null)return current;current=child;}}
    internal static bool ScrollBy(Control start,int pixels){
        for(var control=start;control!=null;control=control.Parent){
            var scroll=control as ScrollableControl;if(scroll==null||!scroll.AutoScroll||!scroll.VerticalScroll.Visible)continue;
            int before=-scroll.AutoScrollPosition.Y,maximum=Math.Max(0,scroll.VerticalScroll.Maximum-scroll.VerticalScroll.LargeChange+1),after=Math.Max(0,Math.Min(maximum,before+pixels));
            if(after==before)continue;scroll.AutoScrollPosition=new Point(-scroll.AutoScrollPosition.X,after);return true;
        }
        return false;
    }
    void Pan(int pixels){
        for(var control=target;control!=null;control=control.Parent){
            var grid=control as DataGridView;
            if(grid!=null&&grid.Rows.Count>0){
                rowPixels+=pixels;int rows=rowPixels/Math.Max(1,grid.RowTemplate.Height);if(rows==0)return;rowPixels-=rows*grid.RowTemplate.Height;
                int before=grid.FirstDisplayedScrollingRowIndex,after=Math.Max(0,Math.Min(Math.Max(0,grid.Rows.Count-grid.DisplayedRowCount(false)),before+rows));
                if(before>=0&&before!=after){try{grid.FirstDisplayedScrollingRowIndex=after;return;}catch(InvalidOperationException){}}
            }
            if(control is ListBox){var list=(ListBox)control;rowPixels+=pixels;int rows=rowPixels/Math.Max(1,list.ItemHeight);if(rows==0)return;rowPixels-=rows*list.ItemHeight;int before=list.TopIndex;list.TopIndex=Math.Max(0,Math.Min(Math.Max(0,list.Items.Count-1),before+rows));if(list.TopIndex!=before)return;}
            var scroll=control as ScrollableControl;if(scroll!=null&&scroll.AutoScroll&&ScrollBy(control,pixels))return;
        }
    }
    public bool PreFilterMessage(ref Message message){
        if(disposed||root.IsDisposed)return false;
        if(message.Msg==0x20a){var receiver=Control.FromChildHandle(message.HWnd);if(receiver==null||(receiver!=root&&!root.Contains(receiver)))return false;var point=Control.MousePosition;if(!root.RectangleToScreen(root.ClientRectangle).Contains(point))return false;var hovered=AtPoint(root,point);for(var c=hovered;c!=null;c=c.Parent)if(c is DataGridView||c is ListBox)return false;int delta=(short)((message.WParam.ToInt64()>>16)&0xffff);return ScrollBy(hovered,-delta*(SystemInformation.MouseWheelScrollLines<0?root.ClientSize.Height:Math.Max(1,SystemInformation.MouseWheelScrollLines)*24)/120);}
        if(message.Msg!=0x119)return false;
        var info=new GestureInfo{size=(uint)Marshal.SizeOf(typeof(GestureInfo))};if(!GetGestureInfo(message.LParam,ref info))return false;
        var source=Control.FromChildHandle(info.target);if(source==null||(source!=root&&!root.Contains(source)))return false;
        if(info.id==4){if((info.flags&1)!=0||!panning){target=AtPoint(root,new Point(info.position.x,info.position.y));previousY=info.position.y;rowPixels=0;panning=true;}else{int pixels=previousY-info.position.y;previousY=info.position.y;Pan(pixels);}if((info.flags&4)!=0){panning=false;target=null;}CloseGestureInfoHandle(message.LParam);return true;}
        if(info.id==2&&panning){panning=false;target=null;CloseGestureInfoHandle(message.LParam);return true;}return false;
    }
    void Unwatch(Control control){control.HandleCreated-=Configure;control.ControlAdded-=Added;foreach(Control child in control.Controls)Unwatch(child);}
    void RootDisposed(object sender,EventArgs e){Dispose();}
    public void Dispose(){if(disposed)return;disposed=true;Application.RemoveMessageFilter(this);root.Disposed-=RootDisposed;Unwatch(root);}
}
